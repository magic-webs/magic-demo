import "server-only";
import { faqs, features, filterRecords, plans, records, SITE_NAME } from "@/lib/sample-site/data";
import {
  BrowserActionError,
  type BrowserAdapter,
  type ElementInfo,
  type Observation,
  type PageState,
  type ScrollResult,
  type TabInfo,
} from "./types";

/**
 * DEMO MODE ONLY. A deterministic simulation of a browser that can only show
 * the built-in sample site (/sample). It is NOT a remote browser and the UI
 * labels it as a simulation. State lives in the URL + scrollY stored in Convex.
 */

const VIEWPORT_HEIGHT = 800;

type DemoAction =
  | { type: "navigate"; to: string }
  | { type: "field"; param: string }
  | { type: "submit"; to: string };

type DemoElement = Omit<ElementInfo, "ref" | "inViewport"> & { y: number; action: DemoAction };
type DemoPage = { title: string; height: number; sections: Array<{ y: number; text: string }>; elements: DemoElement[] };

const nav = (y = 20): DemoElement[] =>
  [
    ["Home", "/sample"],
    ["Pricing", "/sample/pricing"],
    ["Records", "/sample/records"],
    ["Contact", "/sample/contact"],
  ].map(([name, to]) => ({
    role: "link",
    name,
    tag: "a",
    href: to,
    isSubmit: false,
    inForm: false,
    disabled: false,
    y,
    action: { type: "navigate", to },
  }));

function link(name: string, to: string, y: number): DemoElement {
  return { role: "link", name, tag: "a", href: to, isSubmit: false, inForm: false, disabled: false, y, action: { type: "navigate", to } };
}

function pageFor(rawUrl: string): DemoPage | null {
  const url = new URL(rawUrl, "http://demo.local");
  const p = url.searchParams;
  switch (url.pathname.replace(/\/$/, "") || "/") {
    case "/sample":
      return {
        title: `${SITE_NAME} — Home (sample site)`,
        height: 1232,
        sections: [
          { y: 169, text: `# ${SITE_NAME}\nThe friendly records workspace for small teams. (Fictional sample company.)` },
          { y: 531, text: `## Why teams use ${SITE_NAME}\n` + features.map((f) => `${f.title}: ${f.body}`).join("\n") },
          { y: 905, text: "## Ready to try it?\nStart free on Starter, upgrade when you grow." },
          { y: 1150, text: "© Lumen Labs — fictional data for demos." },
        ],
        elements: [...nav(), link("See pricing", "/sample/pricing", 321), link("Browse records", "/sample/records", 321), link("Contact sales", "/sample/contact", 1001)],
      };
    case "/sample/pricing":
      return {
        title: `Pricing — ${SITE_NAME} (sample site)`,
        height: 1577,
        sections: [
          { y: 153, text: "# Simple, honest pricing\nPick a plan. Switch any time." },
          ...plans.map((plan) => ({
            y: 294 + (plan.highlighted ? 28 : 0),
            text: `## ${plan.name} — ${plan.price} ${plan.period}${plan.highlighted ? " (Most popular)" : ""}\n${plan.tagline}\n${plan.features.join(" · ")}`,
          })),
          { y: 775, text: "## Compare plans\nWorkspaces: 1 / 5 / Unlimited · Records: 100 / 10,000 / Unlimited · Support: Community / Email / Priority" },
          { y: 1136, text: "## FAQ\n" + faqs.map((f) => `${f.q} ${f.a}`).join("\n") },
        ],
        elements: [
          ...nav(),
          ...plans.map((plan) => ({
            ...link(`Choose ${plan.name}`, `/sample/contact?plan=${plan.id}`, 630),
          })),
        ],
      };
    case "/sample/records": {
      const q = p.get("q") ?? "";
      const list = filterRecords(q);
      const selected = records.find((r) => r.id === p.get("id"));
      const base = `/sample/records${q ? `?q=${encodeURIComponent(q)}` : ""}`;
      const sep = base.includes("?") ? "&" : "?";
      return {
        title: `Records — ${SITE_NAME} (sample site)`,
        height: 919,
        sections: [
          { y: 137, text: `# Records\n${list.length} of ${records.length} records${q ? ` matching “${q}”` : ""}.` },
          { y: 296, text: list.map((r) => `${r.id} · ${r.name} · ${r.city} · ${r.status}`).join("\n") || "No records match." },
          ...(selected
            ? [{ y: 316, text: `## ${selected.name} (${selected.id})\nCity: ${selected.city}\nIndustry: ${selected.industry}\nStatus: ${selected.status}\nPlan: ${selected.plan}\nContact: ${selected.contact}\nCustomer since: ${selected.since}\nNotes: ${selected.notes}` }]
            : []),
        ],
        elements: [
          ...nav(),
          { role: "searchbox", name: "Search records", tag: "input", inputType: "search", isSubmit: false, inForm: true, disabled: false, y: 197, action: { type: "field", param: "q" } },
          { role: "button", name: "Search", tag: "button", isSubmit: true, inForm: true, disabled: false, y: 197, action: { type: "navigate", to: "/sample/records" } },
          ...list.map((r, i) => link(`Open ${r.name}`, `${base}${sep}id=${r.id}`, 296 + i * 49)),
          ...(selected ? [link("Close details", base, 316)] : []),
        ],
      };
    }
    case "/sample/contact": {
      if (p.get("sent") === "1") {
        return {
          title: `Thanks — ${SITE_NAME} (sample site)`,
          height: 900,
          sections: [{ y: 120, text: "# Thanks! Your message was received.\nThis is a sample form. Nothing was actually sent or stored." }],
          elements: [...nav(), link("Back to home", "/sample", 260)],
        };
      }
      const field = (name: string, param: string, y: number, inputType = "text"): DemoElement => ({
        role: "textbox", name, tag: inputType === "textarea" ? "textarea" : "input", inputType: inputType === "textarea" ? undefined : inputType,
        isSubmit: false, inForm: true, disabled: false, y, action: { type: "field", param },
      });
      const filled = ["name", "email", "message"].map((k) => `${k}: ${p.get(k) ? `“${p.get(k)}”` : "(empty)"}`).join(" · ");
      return {
        title: `Contact — ${SITE_NAME} (sample site)`,
        height: 1000,
        sections: [
          { y: 137, text: `# Contact sales${p.get("plan") ? ` about the ${p.get("plan")} plan` : ""}\nThis harmless sample form doesn't send anything.` },
          { y: 240, text: `Form fields — ${filled}` },
        ],
        elements: [
          ...nav(),
          field("Your name", "name", 261),
          field("Email", "email", 339, "email"),
          field("Message", "message", 417, "textarea"),
          { role: "button", name: "Send message", tag: "button", isSubmit: true, inForm: true, disabled: false, y: 531, action: { type: "submit", to: "/sample/contact?sent=1" } },
        ],
      };
    }
    default:
      return null;
  }
}

function toInfo(el: DemoElement, ref: string, inViewport: boolean): ElementInfo {
  return {
    ref,
    role: el.role,
    name: el.name,
    tag: el.tag,
    inputType: el.inputType,
    href: el.href,
    inViewport,
    isSubmit: el.isSubmit,
    inForm: el.inForm,
    disabled: el.disabled,
  };
}

function toDemoPath(input: string): string | null {
  const trimmed = input.trim();
  if (/^(demo|sample)( website| site)?$/i.test(trimmed)) return "/sample";
  try {
    const url = new URL(trimmed, "http://demo.local");
    if (url.pathname === "/sample" || url.pathname.startsWith("/sample/")) {
      return url.pathname + url.search;
    }
  } catch {
    return null;
  }
  return null;
}

type DemoTab = { tabId: string; url: string; scrollY: number; history: string[]; index: number };

export class DemoAdapter implements BrowserAdapter {
  readonly provider = "demo" as const;
  private tabs: DemoTab[];
  private active: string | undefined;
  private refs = new Map<string, { el: DemoElement; tabId: string; url: string }>();

  constructor(tabs: TabInfo[], activeTabId: string | undefined) {
    this.tabs = tabs.map((t) => ({ tabId: t.tabId, url: t.url, scrollY: t.scrollY ?? 0, history: [t.url], index: 0 }));
    if (this.tabs.length === 0) this.tabs.push(this.newTab("about:blank"));
    this.active = activeTabId && this.tabs.some((t) => t.tabId === activeTabId) ? activeTabId : this.tabs[0].tabId;
  }

  private newTab(url: string): DemoTab {
    return { tabId: `demo-${Math.random().toString(36).slice(2, 8)}`, url, scrollY: 0, history: [url], index: 0 };
  }

  private tab() {
    return this.tabs.find((t) => t.tabId === this.active) ?? this.tabs[0];
  }

  private state(tab: DemoTab): PageState {
    return { tabId: tab.tabId, title: pageFor(tab.url)?.title ?? (tab.url === "about:blank" ? "New tab" : "Not found"), url: tab.url };
  }

  activeTabId() {
    return this.active;
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.tabs.map((t) => ({ ...this.state(t), scrollY: t.scrollY }));
  }

  async observe(): Promise<Observation> {
    const tab = this.tab();
    const page = pageFor(tab.url);
    const prefix = `d${Math.random().toString(36).slice(2, 6)}`;
    this.refs.clear();
    if (!page) {
      return { observationId: prefix, tabId: tab.tabId, url: tab.url, title: this.state(tab).title, scroll: { y: 0, maxY: 0, viewportHeight: VIEWPORT_HEIGHT }, elements: [], text: tab.url === "about:blank" ? "(blank tab)" : "(page not found)" };
    }
    const top = tab.scrollY;
    const bottom = top + VIEWPORT_HEIGHT;
    const elements: ElementInfo[] = page.elements.map((el, i) => {
      const ref = `${prefix}-${i}`;
      this.refs.set(ref, { el, tabId: tab.tabId, url: tab.url });
      return toInfo(el, ref, el.y >= top && el.y < bottom);
    });
    const text = page.sections
      .filter((s) => s.y >= top - 200 && s.y < bottom)
      .map((s) => s.text)
      .join("\n");
    return {
      observationId: prefix,
      tabId: tab.tabId,
      url: tab.url,
      title: page.title,
      scroll: { y: top, maxY: Math.max(0, page.height - VIEWPORT_HEIGHT), viewportHeight: VIEWPORT_HEIGHT },
      elements,
      text: text || "(No headings in view at this scroll position.)",
    };
  }

  describeRef(ref: string) {
    const entry = this.refs.get(ref);
    if (!entry) return null;
    return toInfo(entry.el, ref, true);
  }

  private navigate(tab: DemoTab, url: string) {
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
    tab.url = url;
    tab.scrollY = 0;
    this.refs.clear();
  }

  private locate(ref: string) {
    const entry = this.refs.get(ref);
    const tab = this.tab();
    if (!entry || entry.tabId !== tab.tabId || entry.url !== tab.url) {
      throw new BrowserActionError("STALE_REF", `Element ref "${ref}" is stale. Call observePage again.`);
    }
    return { tab, el: entry.el };
  }

  async openUrl(url: string) {
    const path = toDemoPath(url);
    if (!path) {
      throw new BrowserActionError("DEMO_UNSUPPORTED", "Demo mode can only open the built-in sample site (/sample). Configure Browserbase for real websites.");
    }
    const tab = this.tab();
    this.navigate(tab, path);
    return this.state(tab);
  }

  async click(ref: string) {
    const { tab, el } = this.locate(ref);
    if (el.action.type === "navigate" || el.action.type === "submit") {
      let to = el.action.to;
      if (el.name === "Search" && tab.url.startsWith("/sample/records")) {
        const q = new URL(tab.url, "http://demo.local").searchParams.get("q");
        to = q ? `/sample/records?q=${encodeURIComponent(q)}` : "/sample/records";
      }
      this.navigate(tab, to);
    }
    this.refs.clear();
    return this.state(tab);
  }

  async fill(ref: string, text: string, opts: { submit: boolean }) {
    const { tab, el } = this.locate(ref);
    if (el.action.type !== "field") throw new BrowserActionError("ELEMENT_NOT_FOUND", "That element isn't a text field.");
    const url = new URL(tab.url, "http://demo.local");
    url.searchParams.set(el.action.param, text.slice(0, 500));
    url.searchParams.delete("id");
    const next = url.pathname + url.search;
    // Typing doesn't add history entries, it updates the current one.
    tab.url = next;
    tab.history[tab.index] = next;
    this.refs.clear();
    if (opts.submit && url.pathname === "/sample/records") this.navigate(tab, next);
    return this.state(tab);
  }

  async scroll(direction: "up" | "down", amount: "small" | "page" | "top" | "bottom"): Promise<ScrollResult> {
    const tab = this.tab();
    const page = pageFor(tab.url);
    const maxY = page ? Math.max(0, page.height - VIEWPORT_HEIGHT) : 0;
    const before = tab.scrollY;
    const delta = amount === "small" ? 300 : Math.round(VIEWPORT_HEIGHT * 0.8);
    const target =
      amount === "top" ? 0 : amount === "bottom" ? maxY : before + (direction === "down" ? delta : -delta);
    tab.scrollY = Math.min(Math.max(0, target), maxY);
    this.refs.clear();
    return { ...this.state(tab), before, after: tab.scrollY, maxY };
  }

  async goBack() {
    const tab = this.tab();
    if (tab.index > 0) {
      tab.index -= 1;
      tab.url = tab.history[tab.index];
      tab.scrollY = 0;
    }
    this.refs.clear();
    return this.state(tab);
  }

  async goForward() {
    const tab = this.tab();
    if (tab.index < tab.history.length - 1) {
      tab.index += 1;
      tab.url = tab.history[tab.index];
      tab.scrollY = 0;
    }
    this.refs.clear();
    return this.state(tab);
  }

  async openTab(url: string | null) {
    let path = "about:blank";
    if (url) {
      const p = toDemoPath(url);
      if (!p) throw new BrowserActionError("DEMO_UNSUPPORTED", "Demo mode can only open the built-in sample site (/sample).");
      path = p;
    }
    const tab = this.newTab(path);
    this.tabs.push(tab);
    this.active = tab.tabId;
    this.refs.clear();
    return this.state(tab);
  }

  async switchTab(tabId: string) {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new BrowserActionError("TAB_NOT_FOUND", "No tab with that id. Call listTabs.");
    this.active = tabId;
    this.refs.clear();
    return this.state(tab);
  }

  async closeTab(tabId: string) {
    if (this.tabs.length === 1) throw new BrowserActionError("TAB_LIMIT", "Can't close the last tab.");
    const idx = this.tabs.findIndex((t) => t.tabId === tabId);
    if (idx === -1) throw new BrowserActionError("TAB_NOT_FOUND", "No tab with that id. Call listTabs.");
    this.tabs.splice(idx, 1);
    if (this.active === tabId) this.active = this.tabs[this.tabs.length - 1].tabId;
    this.refs.clear();
    return this.state(this.tab());
  }

  async disconnect() {}
}
