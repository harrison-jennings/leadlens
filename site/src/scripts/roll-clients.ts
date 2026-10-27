// The headline's "every inbox" spins through client names like a slot reel,
// in one smooth motion that slows to rest on "every inbox".
//
// The page's real text never changes: "every inbox" stays in the heading for
// search engines and screen readers, and only turns transparent while a
// decorative reel, laid exactly over it, spins. Names wider than "every
// inbox" are left out, so the reel always fits the space the real words take
// and nothing else in the heading moves. It plays once, shortly after load,
// and not at all for visitors who ask for reduced motion.

// Short enough that the spin is already moving when the page appears, rather
// than seeming to change its mind after "every inbox" has been read.
const START_MS = 150;
// The spin lasts this long per name, so its pace stays the same however many
// names fit.
const STEP_MS = 240;
// Gets up to speed quickly, then takes most of the time slowing down, so the
// last few names are readable as it settles.
const SPIN_EASING = "cubic-bezier(0.45, 0, 0.1, 1)";
const ITEM_EM = 1.3; // a reel item's height; keep in step with site.css

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function play(cycle: HTMLElement): Promise<void> {
  const word = cycle.querySelector<HTMLElement>(".hero-cycle-word");
  if (!word) return;
  // Widths are only right once the heading's font has loaded.
  await document.fonts.ready;
  const final = word.textContent ?? "";
  const names: string[] = JSON.parse(cycle.dataset.words ?? "[]");

  // The reel starts and ends on "every inbox", so it begins and finishes
  // looking exactly like the page without it.
  const reel = document.createElement("span");
  reel.className = "hero-reel";
  reel.setAttribute("aria-hidden", "true");
  const strip = document.createElement("span");
  strip.className = "hero-reel-strip";
  reel.append(strip);
  for (const text of [final, ...names, final]) {
    const item = document.createElement("span");
    item.className = "hero-reel-item";
    item.textContent = text;
    strip.append(item);
  }
  cycle.append(reel);

  const room = word.getBoundingClientRect().width;
  for (const item of [...strip.children].slice(1, -1)) {
    if (item.getBoundingClientRect().width > room + 1) item.remove();
  }

  await pause(START_MS);
  cycle.classList.add("is-rolling");
  const last = strip.children.length - 1;
  await strip.animate(
    [{ transform: "translateY(0)" }, { transform: `translateY(${-last * ITEM_EM}em)` }],
    { duration: last * STEP_MS, easing: SPIN_EASING, fill: "forwards" },
  ).finished;

  cycle.classList.remove("is-rolling");
  reel.remove();
}

const cycle = document.querySelector<HTMLElement>(".hero-cycle");
if (cycle && !matchMedia("(prefers-reduced-motion: reduce)").matches) void play(cycle);
