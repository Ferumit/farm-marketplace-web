// The order lifecycle as the pages show it - the statuses and steps of updateOrderStatus
// (functions/index.js), in the buyer's words and in the farm's. Orders from before this flow carry
// old statuses; they read as their new equivalents here, as they do on the server.

export const LEGACY_STAGE = { pending_payment: "created", confirmed: "accepted", in_progress: "animal_selected" };
export const stageOf = (status) => LEGACY_STAGE[status] || status;

const STATUS = {
  created: { buyer: "Ждёт подтверждения хозяйства", farm: "Новый — примите заказ", tone: "booked" },
  accepted: { buyer: "Принят хозяйством", farm: "Принят — снимите животное", tone: "open" },
  animal_selected: { buyer: "Животное выбрано", farm: "Животное показано — готовьте мясо", tone: "open" },
  meat_ready: { buyer: "Мясо готово", farm: "Мясо готово — отправьте заказ", tone: "open" },
  shipped: { buyer: "Заказ в пути", farm: "Отправлен — отметьте передачу", tone: "open" },
  delivered: { buyer: "Передан вам — подтвердите получение", farm: "Передан — ждём подтверждения", tone: "booked" },
  completed: { buyer: "Сделка завершена", farm: "Сделка завершена", tone: "open" },
  disputed: { buyer: "Спор на рассмотрении", farm: "Покупатель открыл спор", tone: "danger" },
  cancelled: { buyer: "Отменён", farm: "Отменён", tone: "draft" },
};

export function statusText(order, who) {
  const s = STATUS[stageOf(order.status)];
  return s ? s[who] : String(order.status || "");
}
export function statusTone(order) {
  return STATUS[stageOf(order.status)]?.tone || "draft";
}

const ROAD = ["created", "accepted", "animal_selected", "meat_ready", "shipped", "delivered", "completed"];

/** Whether the order has got as far as `stage` (a dispute stops it where it was opened). */
export function reached(order, stage) {
  const s = stageOf(order.status);
  if (s === "cancelled") return stage === "created";
  const at = s === "disputed" ? (order.steps?.handover ? "delivered" : "shipped") : s;
  return ROAD.indexOf(at) >= ROAD.indexOf(stage);
}

export const isFinished = (order) => ["completed", "cancelled"].includes(stageOf(order.status));
export const canCancel = (order) => ["created", "accepted", "animal_selected"].includes(stageOf(order.status));
export const canConfirm = (order) => ["shipped", "delivered"].includes(stageOf(order.status));

// The three parts of the farm's share (functions/index.js payoutPlan).
export const PAYOUT_PARTS = [
  { key: "advance", label: "Аванс 50 %", when: "при принятии заказа" },
  { key: "meat", label: "25 %", when: "когда мясо готово" },
  { key: "final", label: "25 %", when: "после завершения сделки" },
];
export const PAYOUT_STATE = {
  locked: "ждёт своего шага",
  unlocked: "открыт",
  blocked: "заблокирован спором",
  withheld: "удержан по решению спора",
  cancelled: "заказ отменён",
};

export const COMPLETED_BY = {
  buyer: "покупатель подтвердил получение",
  auto: "автоматически через 3 часа после передачи",
  dispute: "по решению платформы",
};

export function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  return null;
}
export function whenLabel(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}

/** A deal whose buyer let the 3 hours pass - either page may complete it when it sees one. */
export function overdue(order) {
  const at = toDate(order.autoCompleteAt);
  return stageOf(order.status) === "delivered" && !!at && at.getTime() <= Date.now();
}
