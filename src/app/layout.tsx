import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'YouTubeChat | AI Video RAG Assistant',
  description: 'Chat with any YouTube video transcript instantly using DeepSeek-R1 and Supabase.',
  icons: {
    // References public/logo.svg automatically as your browser tab icon
    icon: '/logo.svg',
  },
};

// src/app/layout.tsx
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  )
}