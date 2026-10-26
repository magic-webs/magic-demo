import Link from "next/link";
import { Suspense } from "react";

type SearchParams = Promise<{ plan?: string; sent?: string; name?: string; email?: string; message?: string }>;

export default function SampleContactPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
        <Contact searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Contact({ searchParams }: { searchParams: SearchParams }) {
  const p = await searchParams;
  if (p.sent === "1") {
    return (
      <div>
        <h1 className="text-3xl font-bold">Thanks! Your message was received.</h1>
        <p className="mt-3 text-slate-600">This is a sample form. Nothing was actually sent or stored.</p>
        <Link href="/sample" className="mt-6 inline-block text-orange-600 underline">Back to home</Link>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-3xl font-bold">Contact sales{p.plan ? ` about the ${p.plan} plan` : ""}</h1>
      <p className="mt-2 text-slate-600">This harmless sample form doesn&apos;t send anything.</p>
      {/* GET + no storage: submitting just shows a thank-you page. */}
      <form action="/sample/contact" method="get" className="mt-8 flex flex-col gap-4">
        <input type="hidden" name="sent" value="1" />
        {p.plan && <input type="hidden" name="plan" value={p.plan} />}
        <label className="flex flex-col gap-1 text-sm font-medium">
          Your name
          <input name="name" defaultValue={p.name} className="rounded-lg border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Email
          <input name="email" type="email" defaultValue={p.email} className="rounded-lg border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Message
          <textarea name="message" rows={4} defaultValue={p.message} className="rounded-lg border border-slate-300 px-3 py-2 font-normal" />
        </label>
        <button type="submit" className="rounded-lg bg-orange-500 px-4 py-2.5 font-medium text-white hover:bg-orange-600">
          Send message
        </button>
      </form>
    </div>
  );
}
