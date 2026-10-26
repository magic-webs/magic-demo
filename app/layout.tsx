import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import "./globals.css";
import { cn } from "@/lib/utils";
import { Providers } from "@/components/providers";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Magic Browser Assistant",
  description: "Talk to an AI assistant and watch it operate a real remote browser.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", inter.variable)}
    >
      <body className="min-h-full flex flex-col">
        {/* Auth state comes from request cookies, so this subtree renders at request time behind Suspense. */}
        <Suspense>
          <AuthProviders>{children}</AuthProviders>
        </Suspense>
      </body>
    </html>
  );
}

async function AuthProviders({ children }: { children: ReactNode }) {
  await connection();
  return (
    <ConvexAuthNextjsServerProvider>
      <Providers>{children}</Providers>
    </ConvexAuthNextjsServerProvider>
  );
}
