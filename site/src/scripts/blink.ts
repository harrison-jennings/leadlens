// The logo's lens dot behaves like an eye.
//
// - `data-blink="repeat"` (the header): looks around a second after the page
//   loads, then blinks every 8–12 seconds, glancing left and right after every
//   two or three blinks.
// - `data-blink="once"` (the footer): looks around once when it scrolls into
//   view. One eye on repeat is a detail; two would be a distraction.
//
// Either looks around on hover. Nothing moves for visitors who ask for reduced
// motion, and the repeats pause while the tab is hidden.

const TRAVEL = 12; // in the mark's 128-unit space: about 3 px at header size
const LOOK_MS = 2100;
const BLINK_MS = 300;
const FIRST_LOOK_MS = 1000;
const REPEAT_MIN_MS = 8000;
const REPEAT_SPREAD_MS = 4000;

const motion = matchMedia("(prefers-reduced-motion: reduce)");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function blink(eye: SVGElement): Promise<unknown> {
  if (motion.matches) return Promise.resolve();
  // Close, stay shut a moment, open: an eyelid rather than a flicker.
  return eye.animate(
    [
      { transform: "scaleY(1)", easing: "cubic-bezier(.5,0,.9,.6)" },
      { transform: "scaleY(0.08)", offset: 0.33 },
      { transform: "scaleY(0.08)", offset: 0.53, easing: "cubic-bezier(.2,.5,.4,1)" },
      { transform: "scaleY(1)" },
    ],
    { duration: BLINK_MS },
  ).finished;
}

async function lookAround(look: SVGElement, eye: SVGElement) {
  if (motion.matches) return;
  await look.animate(
    [
      { transform: "translateX(0)", easing: "cubic-bezier(.3,0,.2,1)" },
      { transform: `translateX(-${TRAVEL}px)`, offset: 0.13 },
      { transform: `translateX(-${TRAVEL}px)`, offset: 0.42, easing: "cubic-bezier(.4,0,.2,1)" },
      { transform: `translateX(${TRAVEL}px)`, offset: 0.6 },
      { transform: `translateX(${TRAVEL}px)`, offset: 0.85, easing: "cubic-bezier(.4,0,.2,1)" },
      { transform: "translateX(0)" },
    ],
    { duration: LOOK_MS },
  ).finished;
  await pause(140);
  await blink(eye);
}

function animate(svg: SVGSVGElement) {
  const look = svg.querySelector<SVGElement>(".logo-look");
  const eye = svg.querySelector<SVGElement>(".logo-eye");
  if (!look || !eye) return;

  let busy = false;
  const play = async (kind: "look" | "blink") => {
    if (busy) return;
    busy = true;
    try {
      await (kind === "look" ? lookAround(look, eye) : blink(eye));
    } catch {
      // An animation cancelled mid-way (a navigation, a hidden tab) is fine.
    } finally {
      busy = false;
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let sinceGlance = 0;
  const schedule = () => {
    clearTimeout(timer);
    if (motion.matches || document.hidden) return;
    // A glance after two or three blinks, so it never settles into a rhythm.
    const glance = sinceGlance >= 2 && (sinceGlance >= 3 || Math.random() < 0.5);
    timer = setTimeout(async () => {
      sinceGlance = glance ? 0 : sinceGlance + 1;
      await play(glance ? "look" : "blink");
      schedule();
    }, REPEAT_MIN_MS + Math.random() * REPEAT_SPREAD_MS);
  };

  svg.closest("a")?.addEventListener("mouseenter", () => void play("look"));

  if (svg.dataset.blink === "once") {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      void play("look");
    }, { threshold: 1 });
    seen.observe(svg);
    return;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? clearTimeout(timer) : schedule()));
  motion.addEventListener("change", schedule);
  timer = setTimeout(async () => {
    await play("look");
    schedule();
  }, FIRST_LOOK_MS);
}

document.querySelectorAll<SVGSVGElement>("svg[data-blink]").forEach(animate);
