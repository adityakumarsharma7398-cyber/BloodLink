import { useState, type FormEvent } from 'react';
import { SiteHeader } from '@/components/site/SiteHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';

/** Minimal sign-in for the organization workspace. Sessions are Supabase's; the backend never sees a password. */
export function SignIn() {
  const { signInWithPassword } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(null);
    const message = await signInWithPassword(String(form.get('email')), String(form.get('password')));
    setError(message);
    setSubmitting(false);
  };

  return (
    <div className="bg-grey-50 flex min-h-svh flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
        <h1 className="text-2xl">Sign in</h1>
        <p className="text-grey-600 mt-1 text-sm">For hospital and blood-centre staff.</p>
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4 rounded-lg border bg-white p-5 shadow-card">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required autoComplete="username" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          {error && <p className="text-status-critical text-sm">{error}</p>}
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </main>
    </div>
  );
}
