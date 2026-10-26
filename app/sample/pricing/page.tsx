import Link from "next/link";
import { Check } from "lucide-react";
import { faqs, plans } from "@/lib/sample-site/data";

export default function SamplePricing() {
  return (
    <main>
      <section className="mx-auto max-w-5xl px-4 pt-16 pb-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Simple, honest pricing</h1>
        <p className="mt-3 text-slate-600">Pick a plan. Switch any time.</p>
      </section>
      <section className="mx-auto grid max-w-5xl gap-6 px-4 md:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.id}
            className={`flex flex-col rounded-2xl border p-6 ${plan.highlighted ? "border-orange-400 shadow-lg shadow-orange-100" : "border-slate-200"}`}
          >
            {plan.highlighted && <span className="mb-2 w-fit rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Most popular</span>}
            <h2 className="text-xl font-semibold">{plan.name}</h2>
            <p className="mt-1 text-sm text-slate-600">{plan.tagline}</p>
            <p className="mt-4">
              <span className="text-4xl font-bold">{plan.price}</span> <span className="text-slate-500">{plan.period}</span>
            </p>
            <ul className="mt-6 flex flex-1 flex-col gap-2 text-sm">
              {plan.features.map((f) => (
                <li key={f} className="flex items-center gap-2">
                  <Check className="size-4 text-orange-500" />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href={`/sample/contact?plan=${plan.id}`}
              className="mt-6 rounded-lg bg-slate-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-slate-700"
            >
              Choose {plan.name}
            </Link>
          </div>
        ))}
      </section>
      <section className="mx-auto max-w-5xl px-4 py-20">
        <h2 className="text-2xl font-semibold">Compare plans</h2>
        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="py-3">Feature</th>
              {plans.map((p) => (
                <th key={p.id} className="py-3">{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              ["Workspaces", "1", "5", "Unlimited"],
              ["Records", "100", "10,000", "Unlimited"],
              ["Support", "Community", "Email", "Priority"],
              ["Activity history", "7 days", "90 days", "1 year"],
            ].map(([label, ...vals]) => (
              <tr key={label} className="border-b border-slate-100">
                <td className="py-3 font-medium">{label}</td>
                {vals.map((v, i) => (
                  <td key={i} className="py-3 text-slate-600">{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="mx-auto max-w-3xl px-4 pb-24">
        <h2 className="text-2xl font-semibold">FAQ</h2>
        <dl className="mt-6 flex flex-col gap-6">
          {faqs.map((f) => (
            <div key={f.q}>
              <dt className="font-medium">{f.q}</dt>
              <dd className="mt-1 text-slate-600">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
