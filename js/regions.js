// Regions of Kazakhstan: the 17 oblasts and the 3 cities of republican significance, keyed by
// their ISO 3166-2:KZ code (the set in force since the 2022 reform added Abai, Jetisu and Ulytau).
//
// A code, not a name, is what gets stored: names come in Russian and Kazakh, official and
// colloquial, with and without "обл." - and a filter or a map cannot group "Қарағанды облысы",
// "Караганда" and "Карагандинская обл." unless something says they are one place. `center` is the
// administrative centre, used to place a farm that has named its region but set no point.
//
// admin/js/regions.js is a copy of this file (the staff panel is a separate origin and cannot
// import from here) - change both together.

export const REGIONS = [
  { code: "KZ-10", ru: "Абайская область", kz: "Абай облысы", center: [50.4111, 80.2275], capital: "Семей" },
  { code: "KZ-11", ru: "Акмолинская область", kz: "Ақмола облысы", center: [53.2833, 69.3833], capital: "Кокшетау" },
  { code: "KZ-15", ru: "Актюбинская область", kz: "Ақтөбе облысы", center: [50.2839, 57.1670], capital: "Актобе" },
  { code: "KZ-19", ru: "Алматинская область", kz: "Алматы облысы", center: [43.8667, 77.0667], capital: "Конаев" },
  { code: "KZ-23", ru: "Атырауская область", kz: "Атырау облысы", center: [47.1167, 51.8833], capital: "Атырау" },
  { code: "KZ-27", ru: "Западно-Казахстанская область", kz: "Батыс Қазақстан облысы", center: [51.2333, 51.3667], capital: "Уральск" },
  { code: "KZ-31", ru: "Жамбылская область", kz: "Жамбыл облысы", center: [42.9000, 71.3667], capital: "Тараз" },
  { code: "KZ-33", ru: "Жетысуская область", kz: "Жетісу облысы", center: [45.0167, 78.3667], capital: "Талдыкорган" },
  { code: "KZ-35", ru: "Карагандинская область", kz: "Қарағанды облысы", center: [49.8047, 73.1094], capital: "Караганда" },
  { code: "KZ-39", ru: "Костанайская область", kz: "Қостанай облысы", center: [53.2144, 63.6246], capital: "Костанай" },
  { code: "KZ-43", ru: "Кызылординская область", kz: "Қызылорда облысы", center: [44.8528, 65.5092], capital: "Кызылорда" },
  { code: "KZ-47", ru: "Мангистауская область", kz: "Маңғыстау облысы", center: [43.6500, 51.1667], capital: "Актау" },
  { code: "KZ-55", ru: "Павлодарская область", kz: "Павлодар облысы", center: [52.2833, 76.9667], capital: "Павлодар" },
  { code: "KZ-59", ru: "Северо-Казахстанская область", kz: "Солтүстік Қазақстан облысы", center: [54.8667, 69.1500], capital: "Петропавловск" },
  { code: "KZ-61", ru: "Туркестанская область", kz: "Түркістан облысы", center: [43.2973, 68.2518], capital: "Туркестан" },
  { code: "KZ-62", ru: "Улытауская область", kz: "Ұлытау облысы", center: [47.7833, 67.7667], capital: "Жезказган" },
  { code: "KZ-63", ru: "Восточно-Казахстанская область", kz: "Шығыс Қазақстан облысы", center: [49.9483, 82.6278], capital: "Усть-Каменогорск" },
  { code: "KZ-71", ru: "Астана", kz: "Астана", center: [51.1694, 71.4491], city: true },
  { code: "KZ-75", ru: "Алматы", kz: "Алматы", center: [43.2389, 76.8897], city: true },
  { code: "KZ-79", ru: "Шымкент", kz: "Шымкент", center: [42.3417, 69.5901], city: true },
];

const BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));

export function regionByCode(code) {
  return BY_CODE.get(code) || null;
}

export function regionName(code) {
  return BY_CODE.get(code)?.ru || "";
}

// The five zones the catalogue filters by, built from the codes above so nothing is stored twice.
// Astana lies inside Akmola, so it goes north with it; Жетісу was carved out of Алматинская in
// 2022, so it stays south with it.
export const ZONES = [
  { id: "south", name: "Южный", codes: ["KZ-19", "KZ-31", "KZ-33", "KZ-43", "KZ-61", "KZ-75", "KZ-79"] },
  { id: "west", name: "Западный", codes: ["KZ-15", "KZ-23", "KZ-27", "KZ-47"] },
  { id: "north", name: "Северный", codes: ["KZ-11", "KZ-39", "KZ-55", "KZ-59", "KZ-71"] },
  { id: "east", name: "Восточный", codes: ["KZ-10", "KZ-63"] },
  { id: "center", name: "Центральный", codes: ["KZ-35", "KZ-62"] },
];

export function zoneOf(code) {
  return ZONES.find((z) => z.codes.includes(code))?.id || null;
}

export function zoneName(id) {
  return ZONES.find((z) => z.id === id)?.name || "";
}

// Kazakh letters folded onto their Russian look-alikes, so one pattern covers both spellings:
// "Қарағанды" and "Караганда" both become "караганд...".
const FOLD = { "қ": "к", "ғ": "г", "ұ": "у", "ү": "у", "ө": "о", "ә": "а", "і": "и", "ң": "н", "һ": "х", "ё": "е" };
function fold(text) {
  return String(text || "").toLowerCase().replace(/[қғұүөәіңһё]/g, (c) => FOLD[c]).replace(/\s+/g, " ").trim();
}

// A stem as a whole word. JS's \b only knows ASCII letters, so for Cyrillic it has to be spelled out.
const word = (stem) => `(?<!\\p{L})${stem}(?!\\p{L})`;

// First match wins, so the order carries meaning: an oblast named after its capital ("Алматы
// облысы") is tested before the city itself, and the bare word "абай" - also a street in every
// town - only as a last resort, after every city.
const MATCHERS = [
  ["KZ-19", ["алматинск", "алматы обл", "конаев", "капшагай", "капчагай", "almaty region", "almaty obl"]],
  ["KZ-11", ["акмолинск", "акмола обл", "кокшетау", "кокчетав", "щучинск", "степногорск", "бурабай", "akmola", "kokshetau"]],
  ["KZ-63", ["восточно", "шыгыс", word("вко"), "усть-каменогорск", "оскемен", "риддер", "зыряновск", "oskemen", "ust-kamenogorsk", "east kazakhstan"]],
  ["KZ-27", ["западно", "батыс", word("зко"), "уральск", word("орал"), "west kazakhstan", "uralsk"]],
  ["KZ-59", ["северо", "солтустик", word("ско"), "петропавл", "north kazakhstan", "petropavl"]],
  ["KZ-61", ["туркестан", "туркистан", "южно", word("юко"), "сарыагаш", "кентау", "жетысай", "turkistan", "turkestan"]],
  ["KZ-10", ["абайск", "абай обл", "область абай", "области абай", "семей", "семипалатинск", "аягоз", "курчатов", "semey", "abai region", "abay region"]],
  ["KZ-33", ["жетысу", "жетису", "талдыкорган", "текели", "жаркент", "уштобе", "zhetisu", "jetisu", "taldykorgan"]],
  ["KZ-62", ["улытау", "жезказган", "сатпаев", "каражал", "ulytau", "zhezkazgan"]],
  ["KZ-35", ["караганд", "темиртау", "балхаш", "шахтинск", "сарань", "karagand", "qaragand"]],
  ["KZ-39", ["костанай", "кустанай", "рудный", "лисаковск", "аркалык", "kostanay", "kostanai", "qostanai"]],
  ["KZ-43", ["кызылорд", "байконыр", "аральск", "казалинск", "kyzylorda", "qyzylorda"]],
  ["KZ-47", ["мангист", "мангыстау", "мангышлак", word("актау"), "жанаозен", "mangystau", "mangistau", "aktau"]],
  ["KZ-55", ["павлодар", "экибастуз", "pavlodar"]],
  ["KZ-23", ["атырау", "кульсары", "atyrau"]],
  ["KZ-15", ["актюб", "актобе", "кандыагаш", "хромтау", "aktobe", "aqtobe"]],
  ["KZ-31", ["жамбыл", "тараз", "джамбул", "каратау", "zhambyl", "jambyl", "taraz"]],
  ["KZ-79", ["шымкент", "чимкент", "shymkent"]],
  ["KZ-71", ["астана", "нур-султан", "нурсултан", "целиноград", "astana", "nur-sultan"]],
  ["KZ-75", ["алматы", "алма-ата", "almaty"]],
  ["KZ-10", [word("абай"), "abai", "abay"]],
].map(([code, stems]) => [code, new RegExp(stems.join("|"), "u")]);

/**
 * The region a free-text place most likely means, or null. For text typed before regions had
 * codes - farm cities, lot locations, and whatever the mobile apps still send.
 */
export function regionFromText(text) {
  const t = fold(text);
  if (!t) return null;
  for (const [code, re] of MATCHERS) if (re.test(t)) return code;
  return null;
}

/** A partner's region: the stored code when there is one, else read from the city text. */
export function partnerRegion(partner) {
  if (!partner) return null;
  return BY_CODE.has(partner.regionCode) ? partner.regionCode : regionFromText(partner.city);
}

/** A lot's region: its own code, else its location text. */
export function lotRegion(lot) {
  if (!lot) return null;
  return BY_CODE.has(lot.regionCode) ? lot.regionCode : regionFromText(lot.location);
}

/** How to name a lot's place: its region in Russian when known, else whatever text it carries. */
export function lotPlaceLabel(lot) {
  return regionName(lotRegion(lot)) || String(lot?.location || "").trim();
}

/** How to name a farm's place: the settlement and the region, whichever are known. */
export function partnerPlaceLabel(partner) {
  const region = regionName(partnerRegion(partner));
  const city = String(partner?.city || "").trim();
  // The three cities are regions of their own: a farm in Astana would otherwise read
  // "Астана, Астана".
  if (city && region && region.toLowerCase().startsWith(city.toLowerCase())) return region;
  return [city, region].filter(Boolean).join(", ");
}

/** Region <option>s grouped the way Kazakh forms usually are: oblasts, then the three cities. */
export function regionOptionsHtml(selected = "") {
  const opt = (r) => `<option value="${r.code}"${r.code === selected ? " selected" : ""}>${r.ru}</option>`;
  const byName = (a, b) => a.ru.localeCompare(b.ru, "ru");
  const oblasts = REGIONS.filter((r) => !r.city).sort(byName).map(opt).join("");
  const cities = REGIONS.filter((r) => r.city).sort(byName).map(opt).join("");
  return `<optgroup label="Области">${oblasts}</optgroup><optgroup label="Города республиканского значения">${cities}</optgroup>`;
}
