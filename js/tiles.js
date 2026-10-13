// Placeholders for a lot, farm or animal that has no photo yet.
//
// These used to be a cow or horse emoji centred on a gradient - which renders differently on every
// operating system and reads as "image missing" rather than as design. A well-set word in the
// display face on a quiet textured ground reads as an editorial choice instead. The tones are
// deliberately dark in both themes, like the hero, so white type always holds its contrast.

const WORD = { cattle: "Говядина", horse: "Конина", mixed: "Говядина и конина" };
const MONOGRAM = { cattle: "Г", horse: "К", mixed: "Г·К" };

function kind(type) {
  return WORD[type] ? type : "cattle";
}

/**
 * Full-size placeholder for a card photo area. `farm` is for a farm with no lots yet: the old
 * emoji placeholder showed both a cow and a horse there, i.e. claimed an assortment that did not
 * exist. This says what the thing is and promises nothing about what it sells.
 */
export function meatTile(type) {
  if (type === "farm") {
    return `<div class="meat-tile meat-tile--mixed"><span class="meat-tile__kicker">Фермерское хозяйство</span></div>`;
  }
  const t = kind(type);
  return `<div class="meat-tile meat-tile--${t}">
      <span class="meat-tile__kicker">Фермерское мясо</span>
      <span class="meat-tile__word">${WORD[t]}</span>
    </div>`;
}

/** A monogram for the small thumbnails in the farmer's cabinet, where a word will not fit. */
export function meatMonogram(type) {
  const t = kind(type);
  return `<span class="meat-tile meat-tile--${t} meat-tile--mono" aria-label="${WORD[t]}">${MONOGRAM[t]}</span>`;
}

/**
 * An avatar for a farm without a photo: the first letter of its name. Built from text only, and
 * escaped by the caller's own rules - the name is user-controlled.
 */
export function initialOf(name) {
  const letter = String(name || "").replace(/[^\p{L}\p{N}]/gu, "").charAt(0);
  return (letter || "Х").toUpperCase();
}
