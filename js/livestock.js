// Breeds and age categories by species. One source for the farm's livestock form now and for the
// catalogue filters later, so what a farm can enter and what a buyer can filter by never disagree.
//
// Ages are stored as the Kazakh word - what both apps already store ('тай', 'кунан', 'бесті'...).
// Older records spell some of them without Kazakh letters ('кунан'); ageKey() folds the spellings
// together, so an old 'кунан' and a new 'құнан' are the same age to a filter.

export const SPECIES_LABEL = { cattle: "КРС (говядина)", horse: "Лошадь (конина)" };

// For horses, the breeds from leadership's brief; for cattle, the beef and dual-purpose breeds
// actually raised in Kazakhstan. "Другая" in the form lets a farm name anything else, so the list
// is a shortcut, not a cage.
export const BREEDS = {
  horse: ["Казахская типа джабе", "Мугалжарская", "Кушумская", "Адаевская", "Костанайская"],
  cattle: [
    "Казахская белоголовая", "Аулиекольская", "Калмыцкая", "Абердин-ангусская",
    "Герефордская", "Симментальская", "Алатауская",
  ],
};

// The traditional Kazakh age names. For horses, exactly leadership's list plus adults; the hint is
// what a buyer who does not know the word needs to read.
export const AGES = {
  horse: [
    { value: "құлын", hint: "до 6 месяцев" },
    { value: "жабағы", hint: "6–12 месяцев" },
    { value: "тай", hint: "1–2 года" },
    { value: "құнан", hint: "2–3 года" },
    { value: "дөнен", hint: "3–4 года" },
    { value: "бесті", hint: "4–5 лет" },
    { value: "ересек", hint: "старше 5 лет" },
  ],
  cattle: [
    { value: "бұзау", hint: "до 1 года" },
    { value: "торпақ", hint: "1–2 года" },
    { value: "тайынша", hint: "2–3 года" },
    { value: "ересек", hint: "старше 3 лет" },
  ],
};

const FOLD = { "қ": "к", "ғ": "г", "ұ": "у", "ү": "у", "ө": "о", "ә": "а", "і": "и", "ң": "н", "һ": "х", "ё": "е" };
const fold = (text) => String(text || "").toLowerCase().trim().replace(/[қғұүөәіңһё]/g, (c) => FOLD[c]);

/** A comparison key for free text such as a breed: "Казахская  белоголовая" and "казахская белоголовая" match. */
export function nameKey(text) {
  return fold(text).replace(/\s+/g, " ");
}

/** The canonical age value for anything a record may hold, or null when it is not an age we know. */
export function ageKey(raw, species) {
  const f = fold(raw);
  if (!f) return null;
  const lists = species && AGES[species] ? [AGES[species]] : Object.values(AGES);
  for (const list of lists) {
    const hit = list.find((a) => fold(a.value) === f);
    if (hit) return hit.value;
  }
  return null;
}

/** "құнан · 2–3 года" for a known age, the stored text as it is for anything else. */
export function ageLabel(raw, species) {
  const key = ageKey(raw, species);
  if (!key) return String(raw || "");
  const age = (AGES[species] || Object.values(AGES).flat()).find((a) => a.value === key);
  return age ? `${age.value} · ${age.hint}` : key;
}

export function ageOptionsHtml(species, selected = "") {
  const key = ageKey(selected, species);
  return (AGES[species] || []).map((a) =>
    `<option value="${a.value}"${a.value === key ? " selected" : ""}>${a.value} — ${a.hint}</option>`).join("");
}

export function breedOptionsHtml(species, selected = "") {
  const list = BREEDS[species] || [];
  const known = list.includes(selected);
  return list.map((b) => `<option value="${b}"${b === selected ? " selected" : ""}>${b}</option>`).join("")
    + `<option value="__other"${selected && !known ? " selected" : ""}>Другая…</option>`;
}
