import Link from "next/link";
import { features, SITE_NAME } from "@/lib/sample-site/data";

export default function SampleHome() {
  return (
    <main>
      <section className="mx-auto max-w-5xl px-4 py-20">
        <h1 className="max-w-2xl text-5xl font-bold tracking-tight">{SITE_NAME}</h1>
        <p className="mt-4 max-w-xl text-lg text-slate-600">
          The friendly records workspace for small teams. (Fictional sample company.)
        </p>
        <div className="mt-8 flex gap-3">
          <Link href="/sample/pricing" className="rounded-lg bg-orange-500 px-5 py-3 font-medium text-white hover:bg-orange-600">
            See pricing
          </Link>
          <Link href="/sample/records" className="rounded-lg border border-slate-300 px-5 py-3 font-medium hover:bg-slate-50">
            Browse records
          </Link>
        </div>
      </section>
      <section className="bg-slate-50 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <h2 className="text-3xl font-semibold">Why teams use {SITE_NAME}</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="rounded-xl border border-slate-200 bg-white p-6">
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-2 text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-5xl px-4 py-24">
        <h2 className="text-3xl font-semibold">Ready to try it?</h2>
        <p className="mt-3 text-slate-600">Start free on Starter, upgrade when you grow.</p>
        <Link href="/sample/contact" className="mt-6 inline-block rounded-lg border border-slate-300 px-5 py-3 font-medium hover:bg-slate-50">
          Contact sales
        </Link>
      </section>
    </main>
  );
}
