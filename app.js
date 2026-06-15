const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const toKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(year, month - 1, 1);
  return 1 + ((7 + weekday - first.getDay()) % 7) + (nth - 1) * 7;
}

function equinoxDay(year, spring) {
  const base = spring ? 20.8431 : 23.2488;
  const offset = spring ? 1980 : 1980;
  return Math.floor(base + 0.242194 * (year - offset) - Math.floor((year - offset) / 4));
}

function baseHolidayName(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const fixed = {
    "1-1": "元日", "2-11": "建国記念の日", "2-23": "天皇誕生日",
    "4-29": "昭和の日", "5-3": "憲法記念日", "5-4": "みどりの日",
    "5-5": "こどもの日", "8-11": "山の日", "11-3": "文化の日",
    "11-23": "勤労感謝の日"
  };
  if (fixed[`${m}-${d}`]) return fixed[`${m}-${d}`];
  if (m === 1 && d === nthWeekday(y, 1, 1, 2)) return "成人の日";
  if (m === 7 && d === nthWeekday(y, 7, 1, 3)) return "海の日";
  if (m === 9 && d === nthWeekday(y, 9, 1, 3)) return "敬老の日";
  if (m === 10 && d === nthWeekday(y, 10, 1, 2)) return "スポーツの日";
  if (m === 3 && d === equinoxDay(y, true)) return "春分の日";
  if (m === 9 && d === equinoxDay(y, false)) return "秋分の日";
  return "";
}

function holidayName(date) {
  const direct = baseHolidayName(date);
  if (direct) return direct;
  const previous = new Date(date);
  for (let i = 1; i <= 7; i++) {
    previous.setDate(date.getDate() - i);
    if (!baseHolidayName(previous)) break;
    if (previous.getDay() === 0) return "振替休日";
  }
  const before = new Date(date);
  const after = new Date(date);
  before.setDate(date.getDate() - 1);
  after.setDate(date.getDate() + 1);
  if (baseHolidayName(before) && baseHolidayName(after)) return "国民の休日";
  return "";
}

let shownMonth = new Date();
shownMonth.setDate(1);
let selectedDate = toKey(new Date());
let events = JSON.parse(localStorage.getItem("voice-calendar-events") || "[]");
const noticeTimers = new Map();
let googleAccessToken = "";
let googleTokenClient = null;
const googleClientIdKey = "voice-calendar-google-client-id";

function populateTimeOptions() {
  $("eventTime").innerHTML = '<option value="">終日</option>';
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30]) {
      const value = `${pad(hour)}:${pad(minute)}`;
      $("eventTime").insertAdjacentHTML("beforeend", `<option value="${value}">${value}</option>`);
    }
  }
}

function eventStart(event) {
  if (!event.time) return null;
  return new Date(`${event.date}T${event.time}:00`);
}

function showEventNotification(event) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(`1時間後：${event.name}`, {
    body: `${event.date} ${event.time}${event.memo ? `\n${event.memo}` : ""}`,
    tag: `calendar-${event.id}`
  });
}

function scheduleNotifications() {
  noticeTimers.forEach(clearTimeout);
  noticeTimers.clear();
  const now = Date.now();
  events.forEach((event) => {
    const start = eventStart(event);
    if (!start) return;
    const delay = start.getTime() - 60 * 60 * 1000 - now;
    if (delay > 0 && delay <= 2147483647) {
      noticeTimers.set(event.id, setTimeout(() => showEventNotification(event), delay));
    }
  });
}

function updateNoticeStatus() {
  if (!("Notification" in window)) {
    $("noticeStatus").textContent = "このブラウザでは端末通知を利用できません";
    $("noticeButton").disabled = true;
    return;
  }
  const granted = Notification.permission === "granted";
  $("noticeStatus").textContent = granted
    ? "通知は有効です。アプリを開いている間、1時間前にお知らせします"
    : "通知を許可するとお知らせします";
  $("noticeButton").textContent = granted ? "通知は有効" : "通知を許可";
}

function saveEvents() {
  localStorage.setItem("voice-calendar-events", JSON.stringify(events));
  scheduleNotifications();
}

function updateSyncStatus(text = "") {
  const connected = Boolean(googleAccessToken);
  $("syncStatus").textContent = text || (connected ? "Googleカレンダーに接続済み" : "未接続です");
  $("syncButton").disabled = !connected;
  $("disconnectButton").style.visibility = localStorage.getItem(googleClientIdKey) ? "visible" : "hidden";
}

function googleEventBody(event) {
  const body = {
    summary: event.name,
    description: event.memo,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] }
  };
  if (event.time) {
    const start = `${event.date}T${event.time}:00+09:00`;
    const endDate = new Date(`${event.date}T${event.time}:00`);
    endDate.setHours(endDate.getHours() + 1);
    body.start = { dateTime: start, timeZone: "Asia/Tokyo" };
    body.end = { dateTime: `${toKey(endDate)}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00+09:00`, timeZone: "Asia/Tokyo" };
  } else {
    const next = fromKey(event.date);
    next.setDate(next.getDate() + 1);
    body.start = { date: event.date };
    body.end = { date: toKey(next) };
  }
  return body;
}

async function googleRequest(path, options = {}) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${googleAccessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    googleAccessToken = "";
    updateSyncStatus("接続の有効期限が切れました。再接続してください");
    throw new Error("Googleへの再接続が必要です");
  }
  if (!response.ok) throw new Error(`Google同期エラー (${response.status})`);
  return response.status === 204 ? null : response.json();
}

function fromGoogleEvent(item) {
  const startValue = item.start.dateTime || item.start.date;
  const date = startValue.slice(0, 10);
  const time = item.start.dateTime ? startValue.slice(11, 16) : "";
  return {
    id: `google:${item.id}`,
    googleId: item.id,
    name: item.summary || "無題の予定",
    date,
    time,
    memo: item.description || ""
  };
}

async function pushEventToGoogle(event) {
  const body = JSON.stringify(googleEventBody(event));
  if (event.googleId) {
    await googleRequest(`/calendars/primary/events/${encodeURIComponent(event.googleId)}`, { method: "PUT", body });
    return event;
  }
  const created = await googleRequest("/calendars/primary/events", { method: "POST", body });
  event.googleId = created.id;
  event.id = `google:${created.id}`;
  return event;
}

async function syncGoogleCalendar() {
  if (!googleAccessToken) return;
  updateSyncStatus("同期しています…");
  try {
    const localOnly = events.filter((event) => !event.googleId);
    for (const event of localOnly) await pushEventToGoogle(event);
    const min = new Date();
    const max = new Date();
    min.setFullYear(min.getFullYear() - 1);
    max.setFullYear(max.getFullYear() + 2);
    const query = new URLSearchParams({
      timeMin: min.toISOString(), timeMax: max.toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "2500"
    });
    const result = await googleRequest(`/calendars/primary/events?${query}`);
    const googleEvents = result.items.filter((item) => item.status !== "cancelled").map(fromGoogleEvent);
    events = [...events.filter((event) => !event.googleId), ...googleEvents];
    saveEvents();
    render();
    updateSyncStatus(`同期完了：${googleEvents.length}件`);
  } catch (error) {
    updateSyncStatus(error.message);
  }
}

function connectGoogle() {
  const clientId = $("googleClientId").value.trim();
  if (!clientId || !window.google?.accounts?.oauth2) {
    updateSyncStatus("Google接続の準備中です。少し待って再度お試しください");
    return;
  }
  localStorage.setItem(googleClientIdKey, clientId);
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: "https://www.googleapis.com/auth/calendar.events",
    callback: async (response) => {
      if (response.error) {
        updateSyncStatus("Googleへの接続に失敗しました");
        return;
      }
      googleAccessToken = response.access_token;
      $("syncDialog").close();
      updateSyncStatus();
      await syncGoogleCalendar();
    }
  });
  googleTokenClient.requestAccessToken({ prompt: "consent" });
}

function render() {
  renderCalendar();
  renderAgenda();
}

function renderCalendar() {
  $("monthTitle").textContent = `${shownMonth.getFullYear()}年 ${shownMonth.getMonth() + 1}月`;
  const calendar = $("calendar");
  calendar.innerHTML = "";
  const start = new Date(shownMonth.getFullYear(), shownMonth.getMonth(), 1);
  start.setDate(start.getDate() - start.getDay());

  for (let i = 0; i < 42; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = toKey(date);
    const count = events.filter((event) => event.date === key).length;
    const button = document.createElement("button");
    button.className = "day";
    if (date.getDay() === 0) button.classList.add("sunday");
    if (date.getDay() === 6) button.classList.add("saturday");
    const holiday = holidayName(date);
    if (holiday) {
      button.classList.add("holiday");
      button.title = holiday;
    }
    if (date.getMonth() !== shownMonth.getMonth()) button.classList.add("other");
    if (key === toKey(new Date())) button.classList.add("today");
    if (key === selectedDate) button.classList.add("selected");
    button.innerHTML = `<span>${date.getDate()}</span>${count ? `<span class="dots">${'<i class="dot"></i>'.repeat(Math.min(count, 3))}</span>` : ""}`;
    button.addEventListener("click", () => {
      selectedDate = key;
      shownMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      render();
    });
    calendar.appendChild(button);
  }
}

function renderAgenda() {
  const date = fromKey(selectedDate);
  $("selectedTitle").textContent = `${date.getMonth() + 1}月${date.getDate()}日 (${["日","月","火","水","木","金","土"][date.getDay()]})`;
  const list = $("eventList");
  const dayEvents = events.filter((event) => event.date === selectedDate).sort((a, b) => a.time.localeCompare(b.time));
  list.innerHTML = "";
  if (!dayEvents.length) {
    list.innerHTML = '<div class="empty">この日の予定はありません</div>';
    return;
  }
  dayEvents.forEach((event) => {
    const item = document.createElement("article");
    item.className = "event";
    item.innerHTML = `<time>${event.time || "終日"}</time><h3>${escapeHtml(event.name)}</h3>${event.memo ? `<p>${escapeHtml(event.memo)}</p>` : ""}`;
    item.addEventListener("click", () => openDialog(event));
    list.appendChild(item);
  });
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function openDialog(event = null) {
  $("dialogTitle").textContent = event ? "予定を編集" : "予定を追加";
  $("eventId").value = event?.id || "";
  $("eventName").value = event?.name || "";
  $("eventDate").value = event?.date || selectedDate;
  $("eventTime").value = event?.time || "";
  $("eventMemo").value = event?.memo || "";
  $("deleteButton").style.visibility = event ? "visible" : "hidden";
  $("androidCalendarButton").style.visibility = event?.id && event?.time ? "visible" : "hidden";
  $("eventDialog").showModal();
  setTimeout(() => $("eventName").focus(), 50);
}

$("eventForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = $("eventId").value || crypto.randomUUID();
  const item = {
    id,
    name: $("eventName").value.trim(),
    date: $("eventDate").value,
    time: $("eventTime").value,
    memo: $("eventMemo").value.trim()
  };
  const old = events.find((entry) => entry.id === id);
  if (old?.googleId) item.googleId = old.googleId;
  events = events.filter((entry) => entry.id !== id);
  if (googleAccessToken) {
    try { await pushEventToGoogle(item); } catch (error) { updateSyncStatus(error.message); }
  }
  events.push(item);
  selectedDate = item.date;
  shownMonth = new Date(fromKey(item.date).getFullYear(), fromKey(item.date).getMonth(), 1);
  saveEvents();
  $("eventDialog").close();
  render();
});

$("deleteButton").addEventListener("click", async () => {
  const item = events.find((event) => event.id === $("eventId").value);
  if (googleAccessToken && item?.googleId) {
    try {
      await googleRequest(`/calendars/primary/events/${encodeURIComponent(item.googleId)}`, { method: "DELETE" });
    } catch (error) { updateSyncStatus(error.message); return; }
  }
  events = events.filter((event) => event.id !== $("eventId").value);
  saveEvents();
  $("eventDialog").close();
  render();
});
$("closeButton").addEventListener("click", () => $("eventDialog").close());
$("addButton").addEventListener("click", () => openDialog());
$("prevButton").addEventListener("click", () => { shownMonth.setMonth(shownMonth.getMonth() - 1); renderCalendar(); });
$("nextButton").addEventListener("click", () => { shownMonth.setMonth(shownMonth.getMonth() + 1); renderCalendar(); });
$("todayButton").addEventListener("click", () => {
  selectedDate = toKey(new Date());
  shownMonth = new Date();
  shownMonth.setDate(1);
  render();
});

$("noticeButton").addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  await Notification.requestPermission();
  updateNoticeStatus();
  scheduleNotifications();
});

$("syncSettingsButton").addEventListener("click", () => {
  $("googleClientId").value = localStorage.getItem(googleClientIdKey) || "";
  updateSyncStatus();
  $("syncDialog").showModal();
});
$("syncCloseButton").addEventListener("click", () => $("syncDialog").close());
$("syncForm").addEventListener("submit", (event) => {
  event.preventDefault();
  connectGoogle();
});
$("syncButton").addEventListener("click", syncGoogleCalendar);
$("disconnectButton").addEventListener("click", () => {
  if (googleAccessToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(googleAccessToken);
  googleAccessToken = "";
  googleTokenClient = null;
  localStorage.removeItem(googleClientIdKey);
  $("syncDialog").close();
  updateSyncStatus();
});

$("androidCalendarButton").addEventListener("click", () => {
  const event = events.find((entry) => entry.id === $("eventId").value);
  if (!event?.time) return;
  const start = eventStart(event);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const stamp = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Calendar//JP",
    "BEGIN:VEVENT", `UID:${event.id}@calendar`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${event.name.replace(/[,;]/g, " ")}`, `DESCRIPTION:${event.memo.replace(/[,;]/g, " ")}`,
    "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", `DESCRIPTION:${event.name}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  link.download = `${event.name}.ics`;
  link.click();
  URL.revokeObjectURL(link.href);
});

function parseVoice(text) {
  const now = new Date();
  let date = new Date(now);
  if (text.includes("明日")) date.setDate(now.getDate() + 1);
  else if (text.includes("明後日")) date.setDate(now.getDate() + 2);

  const dateMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (dateMatch) {
    date.setMonth(Number(dateMatch[1]) - 1, Number(dateMatch[2]));
    if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) date.setFullYear(now.getFullYear() + 1);
  }
  const timeMatch = text.match(/(\d{1,2})時(?:半|(\d{1,2})分)?/);
  const time = timeMatch ? `${pad(Number(timeMatch[1]))}:${timeMatch[0].includes("半") ? "30" : pad(Number(timeMatch[2] || 0))}` : "";
  const name = text
    .replace(/今日|明日|明後日/g, "")
    .replace(/\d{1,2}月\d{1,2}日/g, "")
    .replace(/\d{1,2}時(?:半|\d{1,2}分)?/g, "")
    .replace(/に予定|の予定|予定/g, "")
    .trim() || "音声で追加した予定";
  return { date: toKey(date), time, name };
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.lang = "ja-JP";
  recognition.interimResults = false;
  recognition.onstart = () => {
    $("voiceButton").classList.add("listening");
    $("voiceHint").textContent = "聞いています…";
  };
  recognition.onend = () => $("voiceButton").classList.remove("listening");
  recognition.onerror = () => { $("voiceHint").textContent = "音声を認識できませんでした。もう一度お試しください"; };
  recognition.onresult = (result) => {
    const text = result.results[0][0].transcript;
    const parsed = parseVoice(text);
    selectedDate = parsed.date;
    openDialog({ id: "", ...parsed, memo: `音声入力：「${text}」` });
    $("voiceHint").textContent = `認識結果：「${text}」`;
  };
  $("voiceButton").addEventListener("click", () => recognition.start());
} else {
  $("voiceButton").disabled = true;
  $("voiceHint").textContent = "このブラウザは音声入力に対応していません";
}

populateTimeOptions();
updateNoticeStatus();
updateSyncStatus();
scheduleNotifications();
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./service-worker.js");
}
