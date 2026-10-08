import { Suspense } from 'react';
import { WorkspaceShell } from '@/components/workspace-shell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div style={{ minHeight: '100vh' }} />}><WorkspaceShell>{children}</WorkspaceShell></Suspense>;
}
