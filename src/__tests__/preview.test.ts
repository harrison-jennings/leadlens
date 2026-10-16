import { describe, expect, test } from "bun:test";
import { EMAIL_CLIENTS } from "@emailens/engine";
import { renderEmail, renderEmails, renderVariants } from "../preview/render";
import {
  localAssetReferences,
  materializeLocalAssets,
  prepareLocalAssets,
} from "../preview/local-assets";
import {
  addClientOptions,
  clientSetOptions,
  clientOptions,
  contentSecurityPolicy,
  escapeAttribute,
  localAssetPresentation,
  marketoControls,
  matchingClientSet,
  normalizeComparisonClients,
  normalizeSavedClientSets,
  normalizeViewportWidth,
  normalizeZoom,
  previewHtml,
  scoreChips,
  viewportOptions,
  type PreviewData,
} from "../preview/content";

/**
 * The preview renders HTML someone else wrote, often carrying a tracking pixel
 * and sometimes carrying a script. Most of what is tested here is containment:
 * that the email cannot run code, cannot phone home unless asked, and cannot
 * break out of the attribute it is written into.
 */

const NONCE = "abcdef0123456789abcdef0123456789";

function data(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    clientId: "gmail-web",
    comparisonMode: false,
    appearanceComparison: false,
    comparisonClientIds: ["gmail-web", "outlook-windows-legacy", "apple-mail-macos"],
    savedClientSets: [],
    darkMode: false,
    loadRemoteImages: false,
    viewportWidth: 600,
    zoom: 1,
    html: "<p>hello</p>",
    scores: { "gmail-web": { score: 90, errors: 0, warnings: 1, info: 0 } },
    warningCount: 1,
    ...overrides,
  };
}

describe("the email is contained", () => {
  test("it renders in a sandbox with neither scripts nor same-origin", () => {
    const page = previewHtml(NONCE, data());
    const iframe = page.match(/<iframe[^>]*>/)![0];
    // A bare `sandbox` is the most restrictive form: every capability off.
    expect(iframe).toContain(" sandbox ");
    expect(iframe).not.toContain("allow-scripts");
    expect(iframe).not.toContain("allow-same-origin");
    expect(iframe).toContain('referrerpolicy="no-referrer"');
  });

  test("a script in the email cannot escape the srcdoc attribute", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const page = previewHtml(NONCE, data({ html: hostile }));
    // Everything is inside the attribute — no raw <script> reaches the page.
    expect(page).not.toContain("<script>alert(2)</script>");
    expect(page).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("an email containing a quote cannot close the attribute", () => {
    const page = previewHtml(NONCE, data({ html: '<div title="x">"</div>' }));
    const iframe = page.match(/<iframe[\s\S]*?>/)![0];
    const srcdoc = iframe.match(/srcdoc="([\s\S]*?)"/)![1];
    expect(srcdoc).not.toContain('"');
    expect(srcdoc).toContain("&quot;");
  });

  test("only our own script may run, and only with the nonce", () => {
    const page = previewHtml(NONCE, data());
    expect(page).toContain(`script-src 'nonce-${NONCE}'`);
    expect(page).toContain(`<script nonce="${NONCE}">`);
  });
});

describe("remote images are a decision, not a default", () => {
  test("off, the policy allows no network image at all", () => {
    const csp = contentSecurityPolicy(NONCE, false);
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("https:");
  });

  test("on, remote images are allowed", () => {
    expect(contentSecurityPolicy(NONCE, true)).toContain("img-src https: http: data:");
  });

  test("nothing else may reach the network in either case", () => {
    for (const remote of [true, false]) {
      const csp = contentSecurityPolicy(NONCE, remote);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("font-src data:");
    }
  });

  test("workspace image access does not turn remote images on", () => {
    const csp = contentSecurityPolicy(NONCE, false, "https://file+.vscode-resource.vscode-cdn.net");
    expect(csp).toContain("img-src data: https://file+.vscode-resource.vscode-cdn.net");
    expect(csp).not.toContain("img-src https: http:");
  });
});

describe("workspace-relative image paths", () => {
  const email = [
    '<img src="images/hero.png" srcset="images/hero.png 1x, /shared/hero@2x.png 2x">',
    '<table background="../images/pattern.png"><tr><td style="background-image:url(\'tiles/grid.png\')">x</td></tr></table>',
    '<style>.banner { background-image: url("images/banner.png"); }</style>',
    '<!--[if mso]><v:fill src="outlook/hero.png"/><![endif]-->',
    '<img src="https://example.com/remote.png"><img src="data:image/png;base64,AAAA">',
    '<img src="{{my.image}}" data-src="images/lazy.png"><script src="scripts/nope.js"></script>',
    '<script>const example = "url(images/script.png)";</script><p>url(images/prose.png)</p>',
  ].join("\n");

  test("finds HTML, responsive, CSS and VML image references without treating runtime URLs as local", () => {
    const found = localAssetReferences(email);
    expect(found.map(({ value, kind }) => [value, kind])).toEqual([
      ["images/hero.png", "src"],
      ["images/hero.png", "srcset"],
      ["/shared/hero@2x.png", "srcset"],
      ["../images/pattern.png", "background"],
      ["tiles/grid.png", "css"],
      ["images/banner.png", "css"],
      ["outlook/hero.png", "src"],
    ]);
    for (const reference of found) {
      expect(email.slice(reference.start, reference.end)).toBe(reference.value);
    }
  });

  test("rewrites only resolved files and restores their webview URIs after client transformation", () => {
    const prepared = prepareLocalAssets(email, (reference) => {
      if (reference.value.includes("pattern")) {
        return { status: "blocked", displayPath: reference.value };
      }
      if (reference.value.includes("outlook")) {
        return { status: "missing", displayPath: reference.value };
      }
      return {
        status: "resolved",
        uri: `https://webview.local/${encodeURIComponent(reference.value)}`,
      };
    });

    expect(prepared.summary.resolved).toBe(5);
    expect(prepared.summary.blocked).toEqual(["../images/pattern.png"]);
    expect(prepared.summary.missing).toEqual(["outlook/hero.png"]);
    expect(prepared.html).toContain("https://leadlens.local.invalid/asset-");
    expect(prepared.html).toContain('../images/pattern.png');
    expect(prepared.html).toContain('outlook/hero.png');

    const transformed = renderVariants(
      prepared.html,
      [{ clientId: "gmail-web", darkMode: false }],
      email,
    ).clients[0].html;
    const materialized = materializeLocalAssets(transformed, prepared.replacements);
    expect(materialized).toContain("https://webview.local/images%2Fhero.png");
    expect(materialized).not.toContain("https://leadlens.local.invalid/");
  });
});

describe("the chrome", () => {
  test("local files are labelled as preview-only and missing paths are escaped", () => {
    const status = localAssetPresentation({
      resolved: 2,
      missing: ['images/<missing>.png'],
      blocked: ["../outside.png"],
    });
    expect(status.label).toBe("Local assets · 2 loaded · 1 missing · 1 outside project");
    expect(status.title).toContain("not valid send-ready email URLs");
    const page = previewHtml(NONCE, data({
      localResourceSource: "https://file+.vscode-resource.vscode-cdn.net",
      localAssets: { resolved: 2, missing: ['images/<missing>.png'], blocked: ["../outside.png"] },
    }));
    expect(page).toContain("Local assets · 2 loaded · 1 missing · 1 outside project");
    expect(page).toContain("images/&lt;missing&gt;.png");
  });

  test("every client is offered, grouped, with the current one selected", () => {
    const options = clientOptions("outlook-windows");
    for (const client of EMAIL_CLIENTS) expect(options).toContain(`value="${client.id}"`);
    expect(options).toContain('<optgroup label="Webmail">');
    expect(options).toContain('<optgroup label="Desktop">');
    expect(options).toContain('<optgroup label="Mobile">');
    expect(options).toContain('value="outlook-windows" selected');
  });

  test("score chips lead with the worst client", () => {
    const chips = scoreChips(
      {
        "gmail-web": { score: 95, errors: 0, warnings: 1, info: 0 },
        "outlook-windows": { score: 40, errors: 3, warnings: 2, info: 0 },
        "apple-mail-macos": { score: 70, errors: 0, warnings: 5, info: 0 },
      },
      "gmail-web",
    );
    const order = [...chips.matchAll(/data-client="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["outlook-windows", "apple-mail-macos", "gmail-web"]);
    expect(chips).toContain("poor");
    expect(chips).toContain("selected");
  });

  test("score chips highlight every visible comparison client", () => {
    const chips = scoreChips(
      {
        "gmail-web": { score: 95, errors: 0, warnings: 1, info: 0 },
        "outlook-windows-legacy": { score: 40, errors: 3, warnings: 2, info: 0 },
        "apple-mail-macos": { score: 90, errors: 0, warnings: 1, info: 0 },
      },
      ["gmail-web", "outlook-windows-legacy"],
    );
    expect(chips.match(/class="chip [^"]*selected"/g)).toHaveLength(2);
  });

  test("the dark-mode toggle is disabled for a client that has none", () => {
    const page = previewHtml(NONCE, data({ darkModeUnsupported: true }));
    expect(page).toMatch(/<button id="dark"[^>]*disabled/);
    expect(page).toContain("This client has no dark mode");
  });

  test("viewport and display zoom are labelled as independent controls", () => {
    const page = previewHtml(NONCE, data());
    expect(page).toContain("Email client</span>");
    expect(page).toContain("Viewport</span>");
    expect(page).toContain("Width</span>");
    expect(page).toContain("Display zoom</span>");
    expect(page).toContain("Scale the preview without changing its CSS viewport");
    expect(page).toContain('value="375">Mobile · 375 px</option>');
    expect(page).toContain('value="600" selected>Desktop · 600 px</option>');
  });

  test("a non-preset width remains visible as a custom choice", () => {
    const options = viewportOptions(520);
    expect(options).toContain('<option value="custom" selected>Custom</option>');
  });

  test("component placement is labelled without allowing template names to inject markup", () => {
    const page = previewHtml(NONCE, data({
      compositionLabel: 'template <draft>.html → Body "copy" (#body)',
    }));
    expect(page).toContain("template &lt;draft&gt;.html → Body \"copy\" (#body)");
    expect(page).not.toContain("template <draft>");
  });

  test("Marketo controls show values and origins without exposing raw HTML", () => {
    const controls = marketoControls({
      context: "template",
      unresolved: 1,
      controls: [{
        kind: "variable",
        id: "hero-copy",
        label: "Hero <copy>",
        type: "html",
        value: '<img src=x onerror="alert(1)">',
        origin: "Override",
        allowHTML: true,
      }],
    });

    expect(controls).toContain("Preview values");
    expect(controls).toContain("Velocity-backed Email Script tokens are not executed");
    expect(controls).toContain("Hero &lt;copy&gt;");
    expect(controls).toContain("&lt;img src=x onerror=\"alert(1)\"&gt;");
    expect(controls).not.toContain("<img src=x");
  });
});

describe("client comparison", () => {
  const cards = [
    {
      previewKey: "gmail-web:light",
      clientId: "gmail-web",
      clientName: "Gmail",
      darkMode: false,
      html: "<p>gmail</p>",
      score: { score: 94, errors: 0, warnings: 1, info: 0 },
      warningCount: 1,
    },
    {
      previewKey: "outlook-windows-legacy:light",
      clientId: "outlook-windows-legacy",
      clientName: "Outlook Classic",
      darkMode: false,
      html: "<p>outlook</p>",
      score: { score: 61, errors: 2, warnings: 3, info: 0 },
      warningCount: 3,
    },
  ];

  test("normalises saved sets to known, unique clients within the four-card limit", () => {
    expect(normalizeComparisonClients([
      "gmail-web",
      "invalid",
      "gmail-web",
      "outlook-web",
      "gmail-ios",
      "apple-mail-ios",
      "yahoo-mail",
    ], "gmail-web")).toEqual(["gmail-web", "outlook-web", "gmail-ios", "apple-mail-ios"]);
    expect(normalizeComparisonClients([], "outlook-windows-legacy")).toEqual([
      "outlook-windows-legacy",
      "gmail-web",
      "apple-mail-macos",
    ]);
  });

  test("renders selected clients side by side with explicit simulation labels", () => {
    const page = previewHtml(NONCE, data({
      comparisonMode: true,
      comparisonClientIds: cards.map((card) => card.clientId),
      comparisonCards: cards,
      sourceLabel: "campaign.html",
    }));
    expect(page.match(/class="preview-card"/g)).toHaveLength(2);
    expect(page.match(/<iframe class="email"/g)).toHaveLength(2);
    expect(page).toContain("Comparing 2 clients");
    expect(page).toContain("Gmail</strong><span>Local simulation · 600 px · Light");
    expect(page).toContain("Outlook Classic</strong><span>Local simulation · 600 px · Light");
    expect(page).toContain("campaign.html · local simulation");
    expect(page).toContain('class="remove-client" data-client="gmail-web" disabled');
  });

  test("every comparison iframe retains the restrictive sandbox", () => {
    const page = previewHtml(NONCE, data({
      comparisonMode: true,
      comparisonClientIds: cards.map((card) => card.clientId),
      comparisonCards: cards,
    }));
    const iframes = [...page.matchAll(/<iframe[\s\S]*?>/g)].map((match) => match[0]);
    expect(iframes).toHaveLength(2);
    for (const iframe of iframes) {
      expect(iframe).toContain(" sandbox ");
      expect(iframe).not.toContain("allow-scripts");
      expect(iframe).not.toContain("allow-same-origin");
      expect(iframe).toContain('referrerpolicy="no-referrer"');
    }
  });

  test("arbitrary email HTML cannot escape any comparison card", () => {
    const page = previewHtml(NONCE, data({
      comparisonMode: true,
      comparisonClientIds: cards.map((card) => card.clientId),
      comparisonCards: [
        { ...cards[0], html: '<img src=x onerror="alert(1)"><script>alert(2)</script>' },
        cards[1],
      ],
    }));
    expect(page).not.toContain("<script>alert(2)</script>");
    expect(page).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("the add-client menu excludes clients already visible", () => {
    const options = addClientOptions(["gmail-web", "outlook-windows-legacy"]);
    expect(options).not.toContain('value="gmail-web"');
    expect(options).not.toContain('value="outlook-windows-legacy"');
    expect(options).toContain('value="apple-mail-macos"');
  });
});

describe("saved client sets", () => {
  const sets = [
    { name: "Core coverage", clientIds: ["gmail-web", "outlook-windows-legacy"] },
    { name: "Apple", clientIds: ["apple-mail-macos", "apple-mail-ios"] },
  ];

  test("keeps only named sets with two to four known, unique clients", () => {
    expect(normalizeSavedClientSets([
      { name: "  Core   coverage  ", clientIds: ["gmail-web", "gmail-web", "invalid", "outlook-web"] },
      { name: "core coverage", clientIds: ["gmail-ios", "gmail-android"] },
      { name: "Same clients", clientIds: ["gmail-web", "outlook-web"] },
      { name: "Too small", clientIds: ["gmail-web"] },
      { name: "Mobile", clientIds: ["gmail-ios", "gmail-android", "apple-mail-ios", "outlook-ios", "yahoo-mobile"] },
      { name: "", clientIds: ["gmail-web", "outlook-web"] },
    ])).toEqual([
      { name: "Core coverage", clientIds: ["gmail-web", "outlook-web"] },
      { name: "Mobile", clientIds: ["gmail-ios", "gmail-android", "apple-mail-ios", "outlook-ios"] },
    ]);
  });

  test("finds an active set only when both client order and membership match", () => {
    expect(matchingClientSet(sets, ["gmail-web", "outlook-windows-legacy"])?.name).toBe("Core coverage");
    expect(matchingClientSet(sets, ["outlook-windows-legacy", "gmail-web"])).toBeUndefined();
  });

  test("labels and escapes reusable sets while selecting the active one", () => {
    const options = clientSetOptions([
      ...sets,
      { name: '<Team "test">', clientIds: ["gmail-ios", "gmail-android"] },
    ], sets[1].clientIds);
    expect(options).toContain('value="Apple" selected>Apple · 2 clients</option>');
    expect(options).toContain('value="&lt;Team &quot;test&quot;&gt;">&lt;Team "test"&gt; · 2 clients</option>');
    expect(options).not.toContain('<Team "test">');
  });

  test("comparison mode can apply and delete a set without saving the same selection twice", () => {
    const page = previewHtml(NONCE, data({
      comparisonMode: true,
      comparisonClientIds: sets[0].clientIds,
      savedClientSets: sets,
      comparisonCards: [
        {
          previewKey: "gmail-web:light",
          clientId: "gmail-web",
          clientName: "Gmail",
          darkMode: false,
          html: "<p>gmail</p>",
          score: { score: 94, errors: 0, warnings: 1, info: 0 },
          warningCount: 1,
        },
        {
          previewKey: "outlook-windows-legacy:light",
          clientId: "outlook-windows-legacy",
          clientName: "Outlook Classic",
          darkMode: false,
          html: "<p>outlook</p>",
          score: { score: 61, errors: 2, warnings: 3, info: 0 },
          warningCount: 3,
        },
      ],
    }));
    expect(page).toContain('id="client-set"');
    expect(page).toContain('value="Core coverage" selected');
    expect(page).toContain('<button id="save-client-set" title="This client selection is already saved" disabled>');
    expect(page).toContain('<button id="delete-client-set" title="Delete the selected saved set">');
    expect(page).toContain('type: "applyClientSet"');
    expect(page).toContain('type: "saveClientSet"');
    expect(page).toContain('type: "deleteClientSet"');

    const unsaved = previewHtml(NONCE, data({
      comparisonMode: true,
      comparisonClientIds: ["gmail-web", "apple-mail-macos"],
      savedClientSets: sets,
      comparisonCards: [],
    }));
    expect(unsaved).toContain('<button id="save-client-set" title="Save these clients as a reusable set">');
  });
});

describe("light and dark comparison", () => {
  const score = { score: 90, errors: 0, warnings: 1, info: 0 };
  const cards = [
    {
      previewKey: "gmail-ios:light",
      clientId: "gmail-ios",
      clientName: "Gmail iOS",
      darkMode: false,
      html: "<p>light</p>",
      score,
      warningCount: 1,
      darkModeUnsupported: false,
    },
    {
      previewKey: "gmail-ios:dark",
      clientId: "gmail-ios",
      clientName: "Gmail iOS",
      darkMode: true,
      html: "<p>dark</p>",
      score,
      warningCount: 1,
      darkModeUnsupported: false,
    },
  ];

  test("shows one client in explicit light and dark cards", () => {
    const page = previewHtml(NONCE, data({
      clientId: "gmail-ios",
      appearanceComparison: true,
      comparisonCards: cards,
      warningCount: 1,
    }));
    expect(page.match(/class="preview-card"/g)).toHaveLength(2);
    expect(page).toContain('data-key="gmail-ios:light"');
    expect(page).toContain('data-key="gmail-ios:dark"');
    expect(page).toContain("Gmail iOS</strong><span>Local simulation · 600 px · Light");
    expect(page).toContain("Gmail iOS</strong><span>Local simulation · 600 px · Dark");
    expect(page).toContain("Light and dark · 1 transform issue");
    expect(page).not.toContain('class="remove-client"');
    expect(page).not.toContain('id="dark"');
  });

  test("both appearance iframes retain the restrictive sandbox and escaped HTML", () => {
    const page = previewHtml(NONCE, data({
      clientId: "gmail-ios",
      appearanceComparison: true,
      comparisonCards: [
        { ...cards[0], html: '<script>alert("light")</script>' },
        { ...cards[1], html: '<script>alert("dark")</script>' },
      ],
    }));
    const iframes = [...page.matchAll(/<iframe[\s\S]*?>/g)].map((match) => match[0]);
    expect(iframes).toHaveLength(2);
    for (const iframe of iframes) {
      expect(iframe).toContain(" sandbox ");
      expect(iframe).not.toContain("allow-scripts");
      expect(iframe).not.toContain("allow-same-origin");
    }
    expect(page).not.toContain('<script>alert("light")</script>');
    expect(page).toContain("&lt;script&gt;alert(&quot;dark&quot;)&lt;/script&gt;");
  });
});

describe("viewport layout", () => {
  test("display zoom scales the frame without changing the CSS viewport width", () => {
    const page = previewHtml(NONCE, data({ viewportWidth: 375, zoom: 0.5 }));
    expect(page).toContain('class="viewport-shell" style="width:187.5px"');
    expect(page).toContain('style="width:375px;height:calc(100% / 0.5);transform:scale(0.5)"');
    expect(page).toContain("375 px CSS viewport at 50% display zoom");
  });

  test("the frame keeps overflow navigation and the iframe keeps full-height scrolling", () => {
    const page = previewHtml(NONCE, data({ html: `<main>${"<p>row</p>".repeat(500)}</main>` }));
    expect(page).toContain("align-items: flex-start; overflow: auto;");
    expect(page).toContain("justify-content: flex-start;");
    expect(page).toContain("margin: 0 auto;");
    expect(page).toContain("height:calc(100% / 1);transform:scale(1)");
    const iframe = page.match(/<iframe[\s\S]*?>/)![0];
    expect(iframe).not.toContain('scrolling="no"');
  });

  test("viewport input is clamped and zoom snaps to supported display scales", () => {
    expect(normalizeViewportWidth(100)).toBe(240);
    expect(normalizeViewportWidth(9000)).toBe(1600);
    expect(normalizeViewportWidth("414.4")).toBe(414);
    expect(normalizeViewportWidth("invalid")).toBe(600);
    expect(normalizeZoom(0.76)).toBe(0.75);
    expect(normalizeZoom(1.4)).toBe(1.5);
    expect(normalizeZoom("invalid")).toBe(1);
  });
});

describe("what the preview shows", () => {
  const HTML = `<html><head><style>.a { border-radius: 8px; }</style></head>
<body><div class="a" style="box-shadow: 0 0 2px #000">hi</div></body></html>`;

  test("the transform differs per client, which is the whole point", () => {
    const gmail = renderEmail(HTML, "gmail-web", false).html;
    const outlook = renderEmail(HTML, "outlook-windows-legacy", false).html;
    expect(gmail).not.toBe(outlook);
  });

  test("dark mode changes the render for a client that supports it", () => {
    const light = renderEmail(HTML, "gmail-ios", false).html;
    const dark = renderEmail(HTML, "gmail-ios", true).html;
    expect(dark).not.toBe(light);
  });

  test("a comparison transforms only its selected clients and shares one score set", () => {
    const comparison = renderEmails(HTML, ["gmail-web", "outlook-windows-legacy"], false);
    expect(comparison.clients).toHaveLength(2);
    expect(comparison.clients[0].html).not.toBe(comparison.clients[1].html);
    expect(comparison.scores["gmail-web"]).toBeDefined();
    expect(comparison.scores["outlook-windows-legacy"]).toBeDefined();
  });

  test("a light and dark pair has distinct keys and shares one client score", () => {
    const pair = renderVariants(HTML, [
      { clientId: "gmail-ios", darkMode: false },
      { clientId: "gmail-ios", darkMode: true },
    ]);
    expect(pair.clients.map((client) => client.previewKey)).toEqual(["gmail-ios:light", "gmail-ios:dark"]);
    expect(pair.clients[0].html).not.toBe(pair.clients[1].html);
    expect(pair.clients[0].warningCount).toBe(pair.clients[1].warningCount);
    expect(pair.scores["gmail-ios"]).toBeDefined();
  });

  test("the escaped email survives the round trip unchanged", () => {
    // What the reader sees must be the transform, character for character.
    const transformed = renderEmail(HTML, "gmail-web", false).html;
    const page = previewHtml(NONCE, data({ html: transformed }));
    // Escaping guarantees no bare quote inside, so the first one ends it.
    const srcdoc = page.match(/srcdoc="([^"]*)"/)![1];
    const unescaped = srcdoc
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(unescaped).toBe(transformed);
  });
});

describe("escaping", () => {
  test("ampersands are escaped first, so entities are not double-decoded", () => {
    expect(escapeAttribute('&amp; "x"')).toBe("&amp;amp; &quot;x&quot;");
  });
});
