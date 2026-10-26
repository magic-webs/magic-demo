import Link from "next/link";
import { Suspense } from "react";
import { Search, X } from "lucide-react";
import { filterRecords, records } from "@/lib/sample-site/data";

type SearchParams = Promise<{ q?: string; id?: string }>;

export default function SampleRecordsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <Suspense fallback={<p className="text-slate-500">Loading records…</p>}>
        <Records searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Records({ searchParams }: { searchParams: SearchParams }) {
  const { q = "", id } = await searchParams;
  const list = filterRecords(q);
  const selected = records.find((r) => r.id === id);
  const base = q ? `/sample/records?q=${encodeURIComponent(q)}` : "/sample/records";
  const withId = (rid: string) => `${base}${base.includes("?") ? "&" : "?"}id=${rid}`;

  return (
    <>
      <h1 className="text-3xl font-bold">Records</h1>
      <form action="/sample/records" method="get" className="mt-6 flex gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search records</label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search records"
          className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2"
        />
        <button type="submit" className="flex items-center gap-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          <Search className="size-4" /> Search
        </button>
      </form>
      <p className="mt-3 text-sm text-slate-500">
        {list.length} of {records.length} records{q ? ` matching “${q}”` : ""}.
      </p>
      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_320px]">
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200">
          {list.map((r) => (
            <li key={r.id}>
              <Link href={withId(r.id)} className={`flex items-center justify-between px-4 py-3 hover:bg-slate-50 ${r.id === id ? "bg-orange-50" : ""}`}>
                <span>
                  <span className="sr-only">Open </span>
                  <span className="font-medium">{r.name}</span>
                  <span className="ml-2 text-sm text-slate-500">{r.id} · {r.city}</span>
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{r.status}</span>
              </Link>
            </li>
          ))}
          {list.length === 0 && <li className="px-4 py-6 text-slate-500">No records match.</li>}
        </ul>
        {selected ? (
          <aside className="h-fit rounded-xl border border-orange-300 bg-orange-50/50 p-5" aria-label="Record details">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-semibold">{selected.name}</h2>
              <Link href={base} aria-label="Close details" className="rounded p-1 hover:bg-orange-100">
                <X className="size-4" />
              </Link>
            </div>
            <dl className="mt-3 grid grid-cols-[110px_1fr] gap-y-2 text-sm">
              <dt className="text-slate-500">ID</dt><dd>{selected.id}</dd>
              <dt className="text-slate-500">City</dt><dd>{selected.city}</dd>
              <dt className="text-slate-500">Industry</dt><dd>{selected.industry}</dd>
              <dt className="text-slate-500">Status</dt><dd>{selected.status}</dd>
              <dt className="text-slate-500">Plan</dt><dd>{selected.plan}</dd>
              <dt className="text-slate-500">Contact</dt><dd>{selected.contact}</dd>
              <dt className="text-slate-500">Customer since</dt><dd>{selected.since}</dd>
              <dt className="text-slate-500">Notes</dt><dd>{selected.notes}</dd>
            </dl>
          </aside>
        ) : (
          <aside className="h-fit rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">Select a record to see its details.</aside>
        )}
      </div>
    </>
  );
}
