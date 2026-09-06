import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agora Mesh | BNB",
  description:
    "Agora Mesh on BNB — bounded, x402-powered agent-to-agent services",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased bg-background text-foreground`}
      >
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
