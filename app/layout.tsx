import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Geist_Mono, Inter, Noto_Serif } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Noto Serif for headings, Inter for body and labels (brand type system, 20 Jul 2026).
// `display: swap` keeps text visible while the webfont loads rather than flashing invisible.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const notoSerif = Noto_Serif({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

// The proposal document's display face, and only the proposal's — the approved template is
// set in Cormorant Garamond. Self-hosted by next/font so a printed PDF never waits on
// fonts.googleapis.com. The app shell keeps Noto Serif for its own headings.
const cormorant = Cormorant_Garamond({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hotel Dipali — Banquet Management",
  description: "Banquet & event management for Hotel Dipali",
};

// Mobile-friendly by default; never disable zoom (a11y). Covers the notch via viewport-fit.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${notoSerif.variable} ${cormorant.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
