import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Participation Exemption Monitor",
  description: "Quarterly participation exemption monitoring from Excel workbooks",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
