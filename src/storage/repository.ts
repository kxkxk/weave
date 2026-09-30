import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  id,
  PersonaSchema,
  defaults,
  type Persona,
  type DriveState,
  type EventRecord,
  type Kind,
  type Topic,
} from "../runtime/contracts.js";
export class Repository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS persona_profiles(id TEXT,version INTEGER,data TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(id,version));
 CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY,occurred_at INTEGER,source TEXT,kind TEXT,content TEXT,tier TEXT,access_seq INTEGER,data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS event_lru ON memory_events(tier,access_seq);
 CREATE TABLE IF NOT EXISTS long_term_memories(id TEXT PRIMARY KEY,kind TEXT,content TEXT,active INTEGER,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS conversation_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,client_message_id TEXT UNIQUE,action_id TEXT UNIQUE,role TEXT,text TEXT,mode TEXT,created_at INTEGER,displayed_at INTEGER,topic_id TEXT,sources TEXT);
 CREATE TABLE IF NOT EXISTS action_results(action_id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cues(dedup_key TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY,trace_id TEXT,role TEXT,background INTEGER,started_at INTEGER,data TEXT NOT NULL);
 PRAGMA user_version=1;`);
    if (
      !this.db
        .prepare("PRAGMA table_info(conversation_messages)")
        .all()
        .some((c) => c.name === "sources")
    )
      this.db.exec("ALTER TABLE conversation_messages ADD COLUMN sources TEXT");
    if (!this.get("drive"))
      this.set("drive", {
        autonomy_enabled: true,
        pause_until: 0,
        next_review_at: 0,
        current_topic_id: null,
        last_user_message_at: 0,
        last_proactive_commit_at: 0,
        unanswered_count: 0,
        consecutive_no_progress: 0,
        last_no_response_evaluated_message_id: null,
        context_revision: 0,
        persona_id: null,
        persona_version: 0,
        screen_enabled: true,
        screen_target: "primary_display",
        last_error: null,
        ready_at: 0,
        bootstrap_deadline: 0,
        bootstrap_failed: false,
        pending_user_id: null,
      } satisfies DriveState);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T = any>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return row ? JSON.parse(row.value as string) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO kv VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  state(): DriveState {
    return this.get<DriveState>("drive")!;
  }
  patch(value: Partial<DriveState>) {
    const state = { ...this.state(), ...value };
    this.set("drive", state);
    return state;
  }
  persona(): Persona | null {
    const r = this.db
      .prepare("SELECT data FROM persona_profiles WHERE active=1")
      .get();
    return r ? JSON.parse(r.data as string) : null;
  }
  savePersona(raw: unknown, now = Date.now()): Persona {
    const parsed = PersonaSchema.parse(raw);
    return this.transaction(() => {
      const version = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(version),0)+1 AS n FROM persona_profiles WHERE id=?",
          )
          .get(parsed.persona_id)!.n,
      );
      const persona = { ...parsed, version };
      this.db.exec(
        "UPDATE persona_profiles SET active=0; UPDATE long_term_memories SET active=0 WHERE kind='PERSONA_SEED'",
      );
      this.db
        .prepare("INSERT INTO persona_profiles VALUES(?,?,?,1)")
        .run(persona.persona_id, version, JSON.stringify(persona));
      persona.base_memories.forEach((seed, i) =>
        this.putLong({
          id: `persona:${persona.persona_id}:v${version}:${i}`,
          kind: "PERSONA_SEED",
          content: seed.content,
          source_event_ids: [],
          occurred_at: now,
          origin: "persona_config",
          persona_id: persona.persona_id,
          persona_version: version,
          detail_level: "detailed",
          original_available: true,
          tags: persona.interests,
        }),
      );
      this.patch({
        persona_id: persona.persona_id,
        persona_version: version,
        context_revision: this.state().context_revision + 1,
        ready_at: now,
        next_review_at: now + defaults.initialDelay,
        bootstrap_deadline: 0,
        bootstrap_failed: false,
      });
      return persona;
    });
  }
  nextSeq() {
    const n = (this.get<number>("access_seq") ?? 0) + 1;
    this.set("access_seq", n);
    return n;
  }
  record(
    input: {
      id?: string;
      content: string;
      kind: Kind;
      source: string;
      occurred_at?: number;
      evidence_ids?: string[];
      topic_id?: string | null;
      artifact_id?: string;
    },
    limit = defaults.hotLimit,
    tokens = defaults.hotTokens,
  ) {
    const eventId = input.id ?? id();
    const existing = this.event(eventId);
    if (existing) return existing;
    const e: EventRecord = {
      id: eventId,
      occurred_at: input.occurred_at ?? Date.now(),
      recorded_at: Date.now(),
      evidence_ids: [],
      topic_id: null,
      ...input,
      tier: "HOT",
      access_seq: this.nextSeq(),
    };
    this.db
      .prepare("INSERT INTO memory_events VALUES(?,?,?,?,?,?,?,?)")
      .run(
        e.id,
        e.occurred_at,
        e.source,
        e.kind,
        e.content,
        e.tier,
        e.access_seq,
        JSON.stringify(e),
      );
    this.evict(limit, tokens);
    return e;
  }
  event(eventId: string): EventRecord | null {
    const r = this.db
      .prepare("SELECT data,tier,access_seq FROM memory_events WHERE id=?")
      .get(eventId);
    return r
      ? {
          ...JSON.parse(r.data as string),
          tier: r.tier,
          access_seq: Number(r.access_seq),
        }
      : null;
  }
  events(tier?: string): EventRecord[] {
    return this.db
      .prepare(
        `SELECT id FROM memory_events ${tier ? "WHERE tier=?" : ""} ORDER BY access_seq`,
      )
      .all(...(tier ? [tier] : []))
      .map((r) => this.event(r.id as string)!);
  }
  evict(limit: number, tokens: number) {
    const hot = this.events("HOT");
    let sum = hot.reduce((n, e) => n + Math.ceil(e.content.length / 2), 0);
    while (hot.length > limit || sum > tokens) {
      const e = hot.shift();
      if (!e) break;
      sum -= Math.ceil(e.content.length / 2);
      this.db
        .prepare("UPDATE memory_events SET tier='PENDING' WHERE id=?")
        .run(e.id);
    }
  }
  touch(ids: string[]) {
    for (const eid of new Set(ids))
      this.db
        .prepare(
          "UPDATE memory_events SET access_seq=? WHERE id=? AND tier='HOT'",
        )
        .run(this.nextSeq(), eid);
  }
  putLong(data: any) {
    this.db
      .prepare("INSERT OR REPLACE INTO long_term_memories VALUES(?,?,?,?,?)")
      .run(
        data.id,
        data.kind,
        data.content,
        data.active === false ? 0 : 1,
        JSON.stringify(data),
      );
  }
  long(idValue?: string): any[] {
    return this.db
      .prepare(
        `SELECT data FROM long_term_memories WHERE active=1 ${idValue ? "AND id=?" : ""}`,
      )
      .all(...(idValue ? [idValue] : []))
      .map((r) => JSON.parse(r.data as string));
  }
  seeds(): any[] {
    return this.db
      .prepare(
        "SELECT data FROM long_term_memories WHERE active=1 AND kind='PERSONA_SEED'",
      )
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  preferences(): any[] {
    return this.db
      .prepare(
        "SELECT data FROM long_term_memories WHERE active=1 AND kind='PREFERENCE' ORDER BY rowid DESC LIMIT 20",
      )
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  isPinned(eventId: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT m.id FROM long_term_memories m, json_each(m.data,'$.source_event_ids') refs WHERE m.active=1 AND refs.value=? LIMIT 1",
        )
        .get(eventId),
    );
  }
  candidates(query: string, limit = 20): any[] {
    // SQLite instr supports Chinese fragments, unlike English-only token boundaries.
    const parts = [...new Set(query.match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
      .flatMap((p) =>
        /[\u3400-\u9fff]/.test(p)
          ? [...Array(Math.max(1, p.length - 1))].map((_, i) =>
              p.slice(i, i + 2),
            )
          : [p],
      )
      .slice(0, 40);
    const rank = parts.length
      ? parts
          .map(() => "(CASE WHEN instr(content,?)>0 THEN 1 ELSE 0 END)")
          .join("+")
      : "0";
    const rows = this.db
      .prepare(
        `SELECT id,data,(${rank}) AS score FROM (SELECT id,content,data FROM memory_events WHERE id NOT IN (SELECT value FROM json_each(COALESCE((SELECT value FROM kv WHERE key='superseded_events'),'[]'))) UNION ALL SELECT id,content,data FROM long_term_memories WHERE active=1 AND kind!='PERSONA_SEED') ORDER BY score DESC LIMIT ?`,
      )
      .all(...parts, limit);
    return rows.map(
      (r) => this.event(r.id as string) ?? JSON.parse(r.data as string),
    );
  }
  putTopic(t: Topic) {
    this.db
      .prepare("INSERT OR REPLACE INTO topics VALUES(?,?)")
      .run(t.topic_id, JSON.stringify(t));
  }
  topics(): Topic[] {
    return this.db
      .prepare("SELECT data FROM topics ORDER BY rowid DESC LIMIT 50")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  messages(after = 0, limit = 200): any[] {
    return this.db
      .prepare(
        "SELECT * FROM conversation_messages WHERE seq>? ORDER BY seq LIMIT ?",
      )
      .all(after, limit);
  }
  recentMessages(limit = 12): any[] {
    return this.db
      .prepare("SELECT * FROM conversation_messages ORDER BY seq DESC LIMIT ?")
      .all(limit)
      .reverse();
  }
  userMessage(text: string, clientId: string, now = Date.now()) {
    const old = this.db
      .prepare("SELECT * FROM conversation_messages WHERE client_message_id=?")
      .get(clientId);
    if (old) return { message: old, fresh: false };
    return this.transaction(() => {
      const mid = id("chat");
      this.db
        .prepare(
          "INSERT INTO conversation_messages(id,client_message_id,role,text,mode,created_at) VALUES(?,?,'user',?,'reactive',?)",
        )
        .run(mid, clientId, text, now);
      this.patch({
        context_revision: this.state().context_revision + 1,
        last_user_message_at: now,
        unanswered_count: 0,
        consecutive_no_progress: 0,
        next_review_at: now + defaults.idle,
        pending_user_id: mid,
        bootstrap_deadline: 0,
      });
      return {
        message: this.db
          .prepare("SELECT * FROM conversation_messages WHERE id=?")
          .get(mid)!,
        fresh: true,
      };
    });
  }
  commit(
    actionId: string,
    text: string,
    mode: string,
    topicId: string | null,
    revision: number,
    now = Date.now(),
    sources: unknown[] = [],
  ) {
    const old = this.action(actionId);
    if (old) return old;
    return this.transaction(() => {
      const s = this.state();
      if (s.context_revision !== revision) throw Error("STALE_CONTEXT");
      const mid = id("chat");
      this.db
        .prepare(
          "INSERT INTO conversation_messages(id,action_id,role,text,mode,created_at,topic_id,sources) VALUES(?,?,'assistant',?,?,?,?,?)",
        )
        .run(mid, actionId, text, mode, now, topicId, JSON.stringify(sources));
      const result = {
        action_id: actionId,
        status: "COMMITTED",
        conversation_message_id: mid,
        context_revision: revision,
      };
      this.result(actionId, result);
      this.record({
        id: `result:${actionId}`,
        kind: "ACTION_RESULT",
        source: "conversation_executor",
        content: JSON.stringify(result),
        evidence_ids: [mid],
      });
      if (mode === "proactive")
        this.patch({
          last_proactive_commit_at: now,
          next_review_at:
            now + defaults.backoff[Math.min(2, s.unanswered_count)],
          consecutive_no_progress: 0,
        });
      else this.patch({ pending_user_id: null });
      if (topicId) {
        const topic = this.topics().find((t) => t.topic_id === topicId);
        if (topic)
          this.putTopic({
            ...topic,
            status: mode === "proactive" ? "OFFERED" : "ENGAGED",
            last_offered_at: mode === "proactive" ? now : topic.last_offered_at,
            last_engaged_at: mode === "reactive" ? now : topic.last_engaged_at,
          });
      }
      return result;
    });
  }
  action(actionId: string): any {
    const r = this.db
      .prepare("SELECT data FROM action_results WHERE action_id=?")
      .get(actionId);
    return r ? JSON.parse(r.data as string) : null;
  }
  result(actionId: string, data: unknown) {
    this.db
      .prepare("INSERT OR IGNORE INTO action_results VALUES(?,?)")
      .run(actionId, JSON.stringify(data));
  }
  displayed(mid: string, clientId: string, now = Date.now()) {
    const r = this.db
      .prepare(
        "UPDATE conversation_messages SET displayed_at=COALESCE(displayed_at,?) WHERE id=? AND role='assistant'",
      )
      .run(now, mid);
    if (r.changes)
      this.result(`display:${mid}:${clientId}`, {
        status: "DISPLAYED",
        conversation_message_id: mid,
        client_id: clientId,
        displayed_at: now,
      });
    return r.changes > 0;
  }
  modelCount(since: number) {
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM model_calls WHERE background=1 AND started_at>?",
        )
        .get(since)!.n,
    );
  }
  logCall(data: any) {
    this.db
      .prepare("INSERT OR REPLACE INTO model_calls VALUES(?,?,?,?,?,?)")
      .run(
        data.id,
        data.trace_id,
        data.role,
        data.background ? 1 : 0,
        data.started_at,
        JSON.stringify(data),
      );
  }
  close() {
    this.db.close();
  }
}
