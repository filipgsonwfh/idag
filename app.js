// @ts-check
/**
 * Idag: a start page over my Linear backlog (team PO).
 * Plain JS, no build step. Type-check with `npx -p typescript tsc -p .`.
 *
 * Flow: render localStorage cache instantly, fetch from Linear, re-render.
 * Actions (Klar / Inte nu / Dött) are optimistic with a 6 s undo.
 */

const API = "https://api.linear.app/graphql";
const STORAGE_PREFIX = "idag:";
const STALE_TODO_DAYS = 14;      // Todo older than this is stale
const STALE_PROGRESS_DAYS = 7;   // In Progress older than this is stale
const REFRESH_AFTER_MS = 60_000; // refetch on focus if the cache is older than this
const UNDO_MS = 6_000;
const DAY_MS = 86_400_000;

const DEMO = new URLSearchParams(location.search).has("demo");

/** @typedef {{ id: string, name: string, type: string, position: number }} State */
/** @typedef {{ id: string, identifier: string, title: string, description: string | null, url: string, createdAt: string, startedAt: string | null, dueDate: string | null, state: State, project: { name: string } | null }} Issue */
/** @typedef {{ team: { id: string, key: string, name: string }, states: State[], issues: Issue[] }} Board */
/** @typedef {{ issue: Issue, age: number, stale: boolean }} Row */
/** @typedef {'done' | 'backlog' | 'cancel'} Action */

// ---------- storage ----------

const store = {
  /** @param {string} k */
  get(k) { try { return localStorage.getItem(STORAGE_PREFIX + k); } catch { return null; } },
  /** @param {string} k @param {string} v */
  set(k, v) { try { localStorage.setItem(STORAGE_PREFIX + k, v); } catch { /* private mode, quota */ } },
  /** @param {string} k */
  del(k) { try { localStorage.removeItem(STORAGE_PREFIX + k); } catch { /* ignore */ } },
};

const settings = {
  get key() { return store.get("key") ?? ""; },
  get team() { return store.get("team") || "PO"; },
};

// ---------- Linear ----------

const BOARD_QUERY = `
  query Board($team: String!) {
    teams(filter: { key: { eq: $team } }, first: 1) {
      nodes {
        id key name
        states(first: 50) { nodes { id name type position } }
        issues(first: 250, filter: { state: { type: { in: ["backlog", "unstarted", "started"] } } }) {
          nodes {
            id identifier title description url createdAt startedAt dueDate
            state { id name type position }
            project { name }
          }
        }
      }
    }
  }
`;

const MOVE_MUTATION = `
  mutation Move($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id state { id name type position } }
    }
  }
`;

const CREATE_MUTATION = `
  mutation Create($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id identifier title description url createdAt startedAt dueDate
        state { id name type position }
        project { name }
      }
    }
  }
`;

const VIEWER_QUERY = `query { viewer { id name displayName } }`;

class LinearError extends Error {
  /** @param {string} message @param {'auth' | 'rate' | 'network' | 'graphql'} kind */
  constructor(message, kind) { super(message); this.kind = kind; }
}

/**
 * @param {string} key
 * @param {string} query
 * @param {Record<string, unknown>} [variables]
 * @returns {Promise<any>}
 */
async function gql(key, query, variables = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Personal API keys are sent as-is; OAuth tokens need Bearer.
        Authorization: key.startsWith("lin_api_") ? key : `Bearer ${key}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new LinearError("Ingen kontakt med Linear.", "network");
  }

  /** @type {any} */
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }

  const authFailed = res.status === 401 || res.status === 403;
  const rateLimited = res.status === 429;
  const first = json?.errors?.[0];
  if (first) {
    const code = String(first.extensions?.code ?? "");
    if (code === "AUTHENTICATION_ERROR" || authFailed) throw new LinearError("Linear godkänner inte nyckeln.", "auth");
    if (code === "RATELIMITED" || rateLimited) throw new LinearError("Linear begränsar anrop just nu. Försök om en stund.", "rate");
    throw new LinearError(String(first.message ?? "Okänt fel från Linear."), "graphql");
  }
  if (authFailed) throw new LinearError("Linear godkänner inte nyckeln.", "auth");
  if (rateLimited) throw new LinearError("Linear begränsar anrop just nu. Försök om en stund.", "rate");
  if (!res.ok || !json?.data) throw new LinearError(`Linear svarade ${res.status}.`, "network");
  return json.data;
}

/** @param {unknown} v @returns {v is State} */
function isState(v) {
  const s = /** @type {any} */ (v);
  return !!s && typeof s.id === "string" && typeof s.name === "string"
    && typeof s.type === "string" && typeof s.position === "number";
}

/** @param {unknown} v @returns {v is Issue} */
function isIssue(v) {
  const i = /** @type {any} */ (v);
  return !!i && typeof i.id === "string" && typeof i.identifier === "string" && typeof i.title === "string"
    && typeof i.url === "string" && typeof i.createdAt === "string" && isState(i.state);
}

/** Keep only the fields we render, with the shapes we expect. @param {Issue} i @returns {Issue} */
function normalizeIssue(i) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    createdAt: i.createdAt,
    description: typeof i.description === "string" ? i.description : null,
    startedAt: typeof i.startedAt === "string" ? i.startedAt : null,
    dueDate: typeof i.dueDate === "string" ? i.dueDate : null,
    state: { id: i.state.id, name: i.state.name, type: i.state.type, position: i.state.position },
    project: i.project && typeof i.project.name === "string" ? { name: i.project.name } : null,
  };
}

/** @param {string} key @param {string} team @returns {Promise<Board>} */
async function fetchBoard(key, team) {
  const data = await gql(key, BOARD_QUERY, { team });
  const node = data?.teams?.nodes?.[0];
  if (!node || typeof node.id !== "string") throw new LinearError(`Hittar inget team med nyckeln ${team}.`, "graphql");
  return {
    team: { id: node.id, key: String(node.key ?? team), name: String(node.name ?? team) },
    states: (node.states?.nodes ?? []).filter(isState),
    issues: (node.issues?.nodes ?? []).filter(isIssue).map(normalizeIssue),
  };
}

/** @param {string} key @param {string} issueId @param {string} stateId */
async function moveIssue(key, issueId, stateId) {
  const data = await gql(key, MOVE_MUTATION, { id: issueId, stateId });
  if (!data?.issueUpdate?.success) throw new LinearError("Linear sparade inte ändringen.", "graphql");
}

/**
 * @param {string} key
 * @param {{ teamId: string, title: string, description: string, stateId?: string }} input
 * @returns {Promise<Issue>}
 */
async function createIssue(key, input) {
  const data = await gql(key, CREATE_MUTATION, { input });
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !isIssue(issue)) throw new LinearError("Linear skapade inte tasken.", "graphql");
  return normalizeIssue(issue);
}

/** @param {string} key @returns {Promise<string>} the viewer's display name */
async function whoAmI(key) {
  const data = await gql(key, VIEWER_QUERY);
  return String(data?.viewer?.displayName || data?.viewer?.name || "okänd");
}

// ---------- demo data (?demo) ----------

/** @returns {Board} */
function demoBoard() {
  const now = Date.now();
  /** @param {number} d */
  const ago = (d) => new Date(now - d * DAY_MS).toISOString();
  /** @type {Record<string, State>} */
  const S = {
    backlog: { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
    todo: { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
    progress: { id: "s-progress", name: "In Progress", type: "started", position: 2 },
    review: { id: "s-review", name: "In Review", type: "started", position: 3 },
    done: { id: "s-done", name: "Done", type: "completed", position: 4 },
    canceled: { id: "s-canceled", name: "Canceled", type: "canceled", position: 5 },
  };
  /**
   * @param {number} n @param {string} title @param {State} state
   * @param {{ created: number, started?: number, desc?: string, project?: string, due?: string }} o
   * @returns {Issue}
   */
  const issue = (n, title, state, o) => ({
    id: `demo-${n}`, identifier: `PO-${n}`, title, url: "https://linear.app", state,
    createdAt: ago(o.created), startedAt: o.started != null ? ago(o.started) : null,
    description: o.desc ?? null, dueDate: o.due ?? null, project: o.project ? { name: o.project } : null,
  });
  return {
    team: { id: "demo", key: "PO", name: "Product Owner" },
    states: Object.values(S),
    issues: [
      issue(41, "Skriv sammanfattning av kundintervjuerna", S.progress, { created: 6, started: 2, desc: "Påhittat exempel." }),
      issue(38, "Granska förslaget till ny prismodell", S.review, { created: 9, started: 1, desc: "Påhittat exempel.", project: "Exempelprojekt" }),
      issue(44, "Prata med Alex om releaseplanen", S.todo, { created: 3, desc: "Påhittat exempel." }),
      issue(40, "Uppdatera roadmapen för nästa kvartal", S.todo, { created: 11 }),
      issue(36, "Svara på offertförfrågan från Exempel AB", S.todo, { created: 17, desc: "Done when: offerten är skickad." }),
      issue(24, "Följ upp leverantörsavtalet", S.todo, { created: 19 }),
      issue(29, "Rensa gamla testkonton", S.todo, { created: 23 }),
      issue(31, "Boka retro med teamet", S.todo, { created: 31, desc: "Påhittat exempel.", due: "2026-11-06" }),
      issue(27, "Flytta dokumentationen till nya wikin", S.todo, { created: 45, desc: "Påhittat exempel." }),
      issue(22, "Beställ nya headsets till kontoret", S.todo, { created: 88 }),
      issue(19, "Utvärdera verktyg för tidrapportering", S.backlog, { created: 60 }),
      issue(12, "Skriv onboarding-guide för nya kollegor", S.backlog, { created: 95 }),
      issue(9, "Se över mallarna för statusrapporter", S.backlog, { created: 120 }),
    ],
  };
}

let demoCounter = 100;

/** @param {string} title @param {string} description @param {State | null} state @returns {Issue} */
function demoIssue(title, description, state) {
  const n = ++demoCounter;
  return {
    id: `demo-${n}`, identifier: `PO-${n}`, title, description, url: "https://linear.app",
    createdAt: new Date().toISOString(), startedAt: null, dueDate: null, project: null,
    state: state ?? { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  };
}

// ---------- model ----------

/** @param {string} iso @param {number} now */
const daysSince = (iso, now) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));

/** Open state types, in the order the groups are shown. */
const OPEN_TYPES = ["started", "unstarted", "triage", "backlog"];

/** @param {Issue} i @param {number} now @returns {Row} */
function toRow(i, now) {
  const type = i.state.type;
  const age = daysSince(type === "started" && i.startedAt ? i.startedAt : i.createdAt, now);
  const stale = type === "started" ? age > STALE_PROGRESS_DAYS : type === "unstarted" ? age > STALE_TODO_DAYS : false;
  return { issue: i, age, stale };
}

/** @typedef {{ state: State, rows: Row[] }} Group */

/** Every open issue, grouped by workflow state. @param {Board} board @param {number} now */
function derive(board, now) {
  const states = board.states
    .filter((s) => OPEN_TYPES.includes(s.type))
    .sort((a, b) => OPEN_TYPES.indexOf(a.type) - OPEN_TYPES.indexOf(b.type) || a.position - b.position);
  /** @type {Group[]} */
  const groups = states
    .map((state) => ({
      state,
      rows: board.issues
        .filter((i) => i.state.id === state.id)
        .map((i) => toRow(i, now))
        .sort((a, b) => b.age - a.age),
    }))
    .filter((g) => g.rows.length > 0);
  const open = groups.reduce((n, g) => n + g.rows.length, 0);
  const stale = groups.reduce((n, g) => n + g.rows.filter((r) => r.stale).length, 0);
  return { groups, open, stale };
}

/** @param {State[]} states @param {string} type @param {string} preferName */
function targetState(states, type, preferName) {
  const c = states.filter((s) => s.type === type).sort((a, b) => a.position - b.position);
  return c.find((s) => s.name === preferName) ?? c[0] ?? null;
}

/** @type {Record<Action, { type: string, name: string, label: string }>} */
const ACTIONS = {
  done: { type: "completed", name: "Done", label: "Klar" },
  backlog: { type: "backlog", name: "Backlog", label: "Inte nu" },
  cancel: { type: "canceled", name: "Canceled", label: "Dött" },
};

// ---------- DOM helpers ----------

/**
 * @param {string} tag
 * @param {Record<string, string | boolean | EventListener>} [attrs]
 * @param {(Node | string | null | false)[]} [children]
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") node.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false) node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Drop null/false entries so the result can be spread into replaceChildren/append.
 * @param {(Node | string | null | false)[]} items @returns {(Node | string)[]} */
function compact(items) {
  return /** @type {(Node | string)[]} */ (items.filter((n) => n !== null && n !== false));
}

/** @param {string} id */
function $(id) {
  const n = document.getElementById(id);
  if (!n) throw new Error(`Missing #${id}`);
  return n;
}

/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ ($(id));
const dialog = () => /** @type {HTMLDialogElement} */ ($("settings"));

const dateFmt = new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit" });
const dueFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" });
/** @param {string} s */
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- app state ----------

/** @type {{ board: Board | null, fetchedAt: number | null, fetching: boolean, error: string | null }} */
const app = { board: null, fetchedAt: null, fetching: false, error: null };

function loadCache() {
  if (DEMO) return; // demo never touches the real cache
  const raw = store.get("cache");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.at === "number" && parsed.board && Array.isArray(parsed.board.issues)) {
      app.board = parsed.board;
      app.fetchedAt = parsed.at;
    }
  } catch {
    store.del("cache");
  }
}

function saveCache() {
  if (DEMO) return;
  if (app.board && app.fetchedAt) store.set("cache", JSON.stringify({ at: app.fetchedAt, board: app.board }));
}

// ---------- rendering ----------

function render() {
  $("date").textContent = capitalize(dateFmt.format(new Date()));
  const connected = DEMO || !!settings.key;
  $("setup").hidden = connected;
  $("board").hidden = !connected;
  $("create-btn").hidden = !connected;
  if (!connected) return;
  if (!app.board) { renderStatus(); return; }

  const { groups, open, stale } = derive(app.board, Date.now());

  $("groups").replaceChildren(...(open
    ? groups.map((g) =>
      el("section", { class: "group" }, [
        el("h2", { class: "label" }, [g.state.name, el("span", { class: "count" }, [String(g.rows.length)])]),
        el("ul", { class: "issues" }, g.rows.map(renderRow)),
      ]))
    : [el("p", { class: "empty" }, [`Inget öppet i ${app.board.team.name}.`])]));

  $("summary").replaceChildren(...compact([
    el("span", {}, [`${open} öppna`]),
    el("span", { class: "sep" }, ["·"]),
    el("span", { class: stale ? "stale" : "" }, [`${stale} stale`]),
  ]));
  renderStatus();
}

/** @param {Row} row */
function renderRow({ issue, age, stale }) {
  const noContext = !issue.description || !issue.description.trim();
  const meta = el("div", { class: "meta" }, [
    el("span", { class: "id" }, [issue.identifier]),
    el("span", { class: `age${stale ? " stale" : ""}`, title: stale ? "Stale" : "Ålder" }, [`${age} d`]),
    issue.project ? el("span", { class: "project" }, [issue.project.name]) : null,
    issue.dueDate ? el("span", { class: "due" }, [`förfaller ${dueFmt.format(new Date(issue.dueDate))}`]) : null,
    noContext
      ? el("span", { class: "nocontext", title: "Beskrivningen är tom. Skriv varför, och vad som gör den klar." }, ["saknar kontext"])
      : null,
  ]);
  const actions = el("div", { class: "actions" }, /** @type {Action[]} */ (Object.keys(ACTIONS))
    .filter((action) => ACTIONS[action].type !== issue.state.type) // no button for the state it is already in
    .map((action) =>
      el("button", { type: "button", class: `act act-${action}`, onclick: () => perform(issue, action) }, [ACTIONS[action].label]),
    ));
  return el("li", { class: `issue${stale ? " is-stale" : ""}`, "data-id": issue.id }, [
    el("a", { class: "title", href: issue.url, target: "_blank", rel: "noopener" }, [issue.title]),
    meta,
    actions,
  ]);
}

function renderStatus() {
  const s = $("status");
  s.className = "status";
  if (app.error) { s.textContent = app.error; s.classList.add("error"); return; }
  if (app.fetching) { s.textContent = "hämtar…"; return; }
  if (DEMO) { s.textContent = "demo · påhittade exempel"; return; }
  s.textContent = app.fetchedAt ? `uppdaterad ${timeFmt.format(new Date(app.fetchedAt))}` : "";
}

// ---------- data flow ----------

/** @param {{ force?: boolean }} [o] */
async function refresh({ force = false } = {}) {
  if (DEMO) {
    if (!app.board) { app.board = demoBoard(); app.fetchedAt = Date.now(); }
    render();
    return;
  }
  if (!settings.key || app.fetching) return;
  if (!force && app.fetchedAt && Date.now() - app.fetchedAt < REFRESH_AFTER_MS) return;
  app.fetching = true;
  app.error = null;
  renderStatus();
  try {
    app.board = await fetchBoard(settings.key, settings.team);
    app.fetchedAt = Date.now();
    saveCache();
  } catch (e) {
    app.error = e instanceof LinearError ? e.message : "Något gick fel.";
  } finally {
    app.fetching = false;
    render();
  }
}

/** @param {string} id @param {State} state */
function setState(id, state) {
  if (!app.board) return;
  const i = app.board.issues.find((x) => x.id === id);
  if (i) i.state = state;
  saveCache();
}

/** Persist a move; on failure revert locally and tell the user. @param {Issue} issue @param {State} to @param {State} revertTo */
async function commit(issue, to, revertTo) {
  if (DEMO) return true;
  try {
    await moveIssue(settings.key, issue.id, to.id);
    return true;
  } catch (e) {
    setState(issue.id, revertTo);
    render();
    showToast(e instanceof LinearError ? e.message : "Kunde inte spara.");
    return false;
  }
}

/** @param {Issue} issue @param {Action} action */
function perform(issue, action) {
  if (!app.board) return;
  const spec = ACTIONS[action];
  const target = targetState(app.board.states, spec.type, spec.name);
  if (!target) { showToast(`Teamet har ingen status av typen ${spec.type}.`); return; }
  const from = issue.state;
  setState(issue.id, target);
  render();
  const pending = commit(issue, target, from);
  showToast(`${issue.identifier} → ${target.name}`, {
    onUndo: async () => {
      if (!(await pending)) return; // the move failed and was already reverted
      setState(issue.id, from);
      render();
      await commit(issue, from, target);
    },
  });
}

// ---------- toast ----------

/** @type {number | undefined} */
let toastTimer;

/** @param {string} message @param {{ onUndo?: () => void }} [o] */
function showToast(message, { onUndo } = {}) {
  const t = $("toast");
  t.replaceChildren(...compact([
    el("span", {}, [message]),
    onUndo ? el("button", { type: "button", class: "undo", onclick: () => { hideToast(); onUndo(); } }, ["Ångra"]) : null,
  ]));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, UNDO_MS);
}

function hideToast() { $("toast").hidden = true; }

// ---------- settings ----------

function openSettings() {
  input("key-input").value = settings.key;
  input("team-input").value = settings.team;
  $("settings-error").textContent = "";
  dialog().showModal();
}

/** @param {SubmitEvent} e */
async function saveSettings(e) {
  e.preventDefault();
  const key = input("key-input").value.trim();
  const team = input("team-input").value.trim().toUpperCase() || "PO";
  const err = $("settings-error");
  const save = /** @type {HTMLButtonElement} */ ($("save-btn"));
  if (!key) { err.textContent = "Klistra in en API-nyckel."; return; }
  save.disabled = true;
  err.textContent = "Kollar nyckeln…";
  try {
    const name = await whoAmI(key);
    store.set("key", key);
    store.set("team", team);
    store.del("cache");
    app.board = null; app.fetchedAt = null; app.error = null;
    dialog().close();
    showToast(`Kopplad som ${name}.`);
    render();
    await refresh({ force: true });
  } catch (e2) {
    err.textContent = e2 instanceof LinearError ? e2.message : "Något gick fel.";
  } finally {
    save.disabled = false;
  }
}

function forget() {
  store.del("key");
  store.del("cache");
  app.board = null; app.fetchedAt = null; app.error = null;
  dialog().close();
  render();
}

// ---------- create ----------

const createDialog = () => /** @type {HTMLDialogElement} */ ($("create"));

function openCreate() {
  if (!app.board) { showToast("Teamet är inte hämtat än."); return; }
  input("new-title").value = "";
  /** @type {HTMLTextAreaElement} */ ($("new-desc")).value = "";
  // One radio per Backlog/Todo-type state in the team, Todo preselected.
  const choices = app.board.states
    .filter((s) => s.type === "backlog" || s.type === "unstarted")
    .sort((a, b) => a.position - b.position);
  const preferred = choices.find((s) => s.type === "unstarted") ?? choices[0];
  $("new-states").replaceChildren(
    el("legend", {}, ["Status"]),
    ...choices.map((s) => el("label", {}, [
      el("input", { type: "radio", name: "new-state", value: s.id, checked: s === preferred }),
      ` ${s.name}`,
    ])),
  );
  $("create-error").textContent = "";
  createDialog().showModal();
  input("new-title").focus();
}

/** @param {SubmitEvent} e */
async function submitCreate(e) {
  e.preventDefault();
  if (!app.board) return;
  const title = input("new-title").value.trim();
  const description = /** @type {HTMLTextAreaElement} */ ($("new-desc")).value.trim();
  const checked = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="new-state"]:checked'));
  const stateId = checked?.value || undefined;
  const state = app.board.states.find((s) => s.id === stateId) ?? null;
  const err = $("create-error");
  if (!title) { err.textContent = "Skriv en titel."; return; }
  if (!description) { err.textContent = "Skriv en rad sammanhang. Utan den säger titeln inget om tre veckor."; return; }
  const save = /** @type {HTMLButtonElement} */ ($("create-save"));
  save.disabled = true;
  err.textContent = "Skapar…";
  try {
    const issue = DEMO
      ? demoIssue(title, description, state)
      : await createIssue(settings.key, { teamId: app.board.team.id, title, description, stateId });
    app.board.issues.push(issue);
    saveCache();
    createDialog().close();
    render();
    showToast(`${issue.identifier} skapad i ${issue.state.name}.`);
  } catch (e2) {
    err.textContent = e2 instanceof LinearError ? e2.message : "Något gick fel.";
  } finally {
    save.disabled = false;
  }
}

// ---------- init ----------

function init() {
  loadCache();
  render();
  $("settings-btn").addEventListener("click", openSettings);
  $("setup-btn").addEventListener("click", openSettings);
  $("cancel-btn").addEventListener("click", () => dialog().close());
  $("forget-btn").addEventListener("click", forget);
  $("refresh-btn").addEventListener("click", () => refresh({ force: true }));
  $("settings-form").addEventListener("submit", saveSettings);
  $("create-btn").addEventListener("click", openCreate);
  $("create-cancel").addEventListener("click", () => createDialog().close());
  $("create-form").addEventListener("submit", submitCreate);
  // "c" opens the create dialog, like in Linear. Not while typing or with a dialog open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (document.querySelector("dialog[open]") || $("create-btn").hidden) return;
    e.preventDefault();
    openCreate();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  window.addEventListener("focus", () => refresh());
  refresh();

  // Re-render when the date flips (a tab left open past midnight).
  let shown = dateFmt.format(new Date());
  setInterval(() => {
    const now = dateFmt.format(new Date());
    if (now !== shown) { shown = now; render(); }
  }, 60_000);
}

init();
