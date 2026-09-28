import { SiteHeader } from '@/components/site/SiteHeader';
import { Button } from '@/components/ui/button';

/** Shown for routes whose screens are built in a later phase. */
export function Placeholder() {
  return (
    <div className="bg-grey-50 flex min-h-svh flex-col">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <h1 className="text-2xl">This page isn't built yet</h1>
        <p className="text-grey-600 mt-2">
          <code className="bg-grey-100 rounded px-1.5 py-0.5 text-sm">{window.location.pathname}</code> is part of a later build phase.
        </p>
        <Button className="mt-6" asChild>
          <a href="/">Back to home</a>
        </Button>
      </main>
    </div>
  );
}
