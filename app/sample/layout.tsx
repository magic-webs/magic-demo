import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { SITE_NAME } from "@/lib/sample-site/data";

export const metadata: Metadata = {
  title: `${SITE_NAME} (sample site)`,
  robots: { index: false, follow: false },
};

const nav = [
  { href: "/sample", label: "Home" },
  { href: "/sample/pricing", label: "Pricing" },
  { href: "/sample/records", label: "Records" },
  { href: "/sample/contact", label: "Contact" },
];

/** Built-in fictional website for demos and repeatable tests. Public, no auth. */
export default function SampleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-white text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-5xl items-center gap-6 px-4">
          <Link href="/sample" className="flex items-center gap-2 font-semibold">
            <Sparkles className="size-5 text-orange-500" />
            {SITE_NAME}
          </Link>
          <div className="ml-auto flex items-center gap-1 text-sm">
            {nav.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-md px-3 py-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      </header>
      <div className="bg-amber-50 py-1 text-center text-xs text-amber-800">Sample website with fictional data, for demos and tests.</div>
      {children}
      <footer className="border-t border-slate-200 py-8 text-center text-sm text-slate-500">© {SITE_NAME} — fictional company and data.</footer>
    </div>
  );
}
