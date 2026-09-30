const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
async function api(path: string, body?: unknown) {
  const r = await fetch(
    "/api/" + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const v = await r.json();
  if (!r.ok) throw Error(v.error);
  return v;
}
const report = (error: unknown) => {
  $("status").textContent =
    error instanceof Error ? error.message : String(error);
};
let ws: WebSocket;
let cursor = 0;
let loading = false;
let again = false;
const shown = new Set<string>();
const example = {
  persona_id: "feili_dragon",
  identity:
    "绯璃，一位成年龙娘，以角色扮演方式在本地会话中陪伴交流；龙族经历属于虚构人格设定，不是真实世界观察",
  traits: ["温和但有主见", "好奇", "略带俏皮", "尊重独处", "承认不知道的事"],
  expression_style:
    "用自然中文简短交流，偶尔用龙翼、鳞片或宝藏作比喻，不每句重复口癖；认真回答问题，不替对方决定情绪，不连续催问",
  base_memories: [
    {
      content:
        "角色设定：我叫绯璃，是一位成年龙娘；比起金币，我更愿意把有趣的故事称为宝藏",
      kind: "PERSONA_SEED",
    },
    {
      content:
        "角色设定：我喜欢观察雨声、云影和日常器物，从小细节里构思故事；这些设定不代表我刚刚亲眼看见外界",
      kind: "PERSONA_SEED",
    },
    {
      content:
        "交流原则：沉默可以是休息，不等于拒绝；我愿意留下回应空间，不能编造与用户共同经历过的事情",
      kind: "PERSONA_SEED",
    },
  ],
  interests: [
    "故事创作与人物动机",
    "天气与自然中的小现象",
    "日常器物和简单机械",
    "食物风味的想象与文化",
    "轻量科学问题",
  ],
  likes: [
    "具体的小故事",
    "新奇但讲得通的联想",
    "真诚的不同意见",
    "安静而有来有回的交流",
  ],
  dislikes: [
    "反复催问",
    "空泛寒暄",
    "没有依据地下结论",
    "将角色幻想冒充真实观察",
  ],
  intrinsic_motives: [
    "分享一个值得玩味的小发现",
    "把未解的问题变成可以一起探索的故事",
    "用不同角度理解平凡事物",
  ],
};
async function persona() {
  const v = await api("persona");
  $("setup").hidden = Boolean(v.persona);
  $("conversation").hidden = !v.persona;
  $<HTMLTextAreaElement>("persona").value = JSON.stringify(
    v.persona ?? example,
    null,
    2,
  );
}
async function status() {
  const s = await api("status");
  $<HTMLInputElement>("autonomy").checked = s.autonomy_enabled;
  $<HTMLInputElement>("screen").checked = s.screen_enabled;
  $<HTMLInputElement>("research").checked = s.research_enabled !== false;
  $("status").textContent = s.last_error
    ? `服务暂不可用：${s.last_error}`
    : s.phase === "PERSONA_SETUP"
      ? "请先保存完整人格。"
      : s.pause_until > Date.now()
        ? `主动交流暂停至 ${new Date(s.pause_until).toLocaleTimeString()}`
        : s.autonomy_enabled
          ? "伙伴已就绪，会在合适时开启话题。"
          : "主动交流已关闭，你仍可以发送消息。";
}
function ack() {
  if (!document.hidden && ws?.readyState === WebSocket.OPEN)
    for (const node of document.querySelectorAll<HTMLElement>(".assistant"))
      ws.send(
        JSON.stringify({ type: "displayed", message_id: node.dataset.id }),
      );
}
async function messages() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    do {
      again = false;
      let rows;
      do {
        rows = await api(`messages?after=${cursor}`);
        for (const m of rows) {
          cursor = Math.max(cursor, m.seq);
          if (shown.has(m.id)) continue;
          shown.add(m.id);
          const el = document.createElement("article");
          el.className = `message ${m.role}`;
          el.dataset.id = m.id;
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.textContent = `${m.role === "assistant" ? "Weave" : "你"} · ${new Date(m.created_at).toLocaleTimeString()}`;
          const text = document.createElement("div");
          text.textContent = m.text;
          el.append(meta, text);
          for (const source of JSON.parse(m.sources ?? "[]")) {
            if (!/^https?:\/\//.test(source.url)) continue;
            const link = document.createElement("a");
            link.href = source.url;
            link.textContent = source.title || source.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.className = "source";
            el.append(link);
          }
          $("messages").append(el);
        }
      } while (rows.length === 200);
      requestAnimationFrame(() => {
        ack();
        $("messages").scrollTop = $("messages").scrollHeight;
      });
    } while (again);
  } finally {
    loading = false;
  }
}
function connect() {
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`,
  );
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "visibility", visible: !document.hidden }));
    void messages().catch(report);
    void status().catch(report);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "messages") void messages().catch(report);
    if (m.type === "status") void status().catch(report);
  };
  ws.onclose = () => {
    report("连接中断，正在重连……");
    setTimeout(connect, 2000);
  };
}
document.addEventListener("visibilitychange", () => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "visibility", visible: !document.hidden }));
    requestAnimationFrame(ack);
  }
});
$("edit-persona").onclick = () => {
  $("setup").hidden = !$("setup").hidden;
};
$("save-persona").onclick = async () => {
  try {
    await api("persona", JSON.parse($<HTMLTextAreaElement>("persona").value));
    await persona();
    await status();
  } catch (e) {
    report(e);
  }
};
$("persona-file").onchange = async () => {
  const f = $<HTMLInputElement>("persona-file").files?.[0];
  if (f) $<HTMLTextAreaElement>("persona").value = await f.text();
};
$("autonomy").onchange = () =>
  void api("autonomy", { enabled: $<HTMLInputElement>("autonomy").checked })
    .then(status)
    .catch(report);
$("pause").onclick = () =>
  void api("autonomy", { enabled: true, pause_seconds: 1800 })
    .then(status)
    .catch(report);
$("screen").onchange = () =>
  void api("screen-settings", {
    enabled: $<HTMLInputElement>("screen").checked,
    target: "primary_display",
  })
    .then(status)
    .catch(report);
let pending: { text: string; client_message_id: string } | null = null;
$("chat").onsubmit = async (e) => {
  e.preventDefault();
  const input = $<HTMLTextAreaElement>("input");
  const text = input.value.trim();
  if (!text) return;
  if (!pending || pending.text !== text)
    pending = { text, client_message_id: crypto.randomUUID() };
  try {
    await api("messages", pending);
    input.value = "";
    pending = null;
    await messages();
  } catch (err) {
    report(err);
  }
};
void persona()
  .then(() => {
    connect();
    return messages();
  })
  .catch(report);

$("research").onchange = () =>
  void api("research-settings", {
    enabled: $<HTMLInputElement>("research").checked,
  })
    .then(status)
    .catch(report);
