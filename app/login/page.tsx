import LoginForm from '@/components/LoginForm';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import { previewLoginAllowed } from '@/lib/auth';

export default function LoginPage() {
  return (
    <main className="wrap">
      <h1>Nya</h1>
      <p className="sub">Enter your password to continue</p>
      <LoginForm previewLogin={previewLoginAllowed()} />
      <CoverageNote />
      <TrustLinks />
    </main>
  );
}
