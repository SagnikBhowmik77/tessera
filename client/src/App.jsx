import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './context/AuthContext.jsx';
import { api, tokenStore } from './lib/api.js';
import { qk } from './lib/qk.js';
import { Spinner } from './components/ui.jsx';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/AuthPages.jsx';
import { NotFoundPage } from './components/states.jsx';

// Loaded when first opened, so the first visit downloads less (charts are the heaviest part). The
// signed-in shell, projects and board are split off too: someone opening a public report link on
// a phone downloads only the report page, not the whole app.
const load = {
  shell: () => import('./components/AppShell.jsx'),
  projects: () => import('./pages/ProjectsPage.jsx'),
  board: () => import('./pages/BoardPage.jsx'),
  analytics: () => import('./pages/AnalyticsPage.jsx'),
  portal: () => import('./pages/PortalPage.jsx'),
  drawer: () => import('./components/TicketDrawer.jsx'),
  landing: () => import('./pages/LandingPage.jsx'),
};
const LandingPage = lazy(load.landing);
const AppShell = lazy(load.shell);
const ProjectsPage = lazy(load.projects);
const BoardPage = lazy(load.board);
const ListPage = lazy(() => import('./pages/ListPage.jsx'));
const SprintsPage = lazy(() => import('./pages/SprintsPage.jsx'));
const CalendarPage = lazy(() => import('./pages/CalendarPage.jsx'));
const TimelinePage = lazy(() => import('./pages/TimelinePage.jsx'));
const TriagePage = lazy(() => import('./pages/TriagePage.jsx'));
const ComparePage = lazy(() => import('./pages/ComparePage.jsx'));
const DeploysPage = lazy(() => import('./pages/DeploysPage.jsx'));
const FlowPage = lazy(() => import('./pages/FlowPage.jsx'));
const TogetherPage = lazy(() => import('./pages/TogetherPage.jsx'));
const StatusPage = lazy(() => import('./pages/StatusPage.jsx'));
const SprintReportPage = lazy(() => import('./pages/SprintReportPage.jsx'));
const MyWorkPage = lazy(() => import('./pages/MyWorkPage.jsx'));
const AnalyticsPage = lazy(load.analytics);
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx'));
const ReleaseNotesPage = lazy(() => import('./pages/ReleaseNotesPage.jsx'));
const PortalPage = lazy(load.portal);
const WorkspacesPage = lazy(() => import('./pages/WorkspacesPage.jsx'));
const TrackPage = lazy(() => import('./pages/TrackPage.jsx'));
const RoadmapPage = lazy(() => import('./pages/RoadmapPage.jsx'));
const SharedBoardPage = lazy(() => import('./pages/SharedBoardPage.jsx'));
const InvitePage = lazy(() => import('./pages/InvitePage.jsx'));
const AccountPage = lazy(() => import('./pages/AccountPage.jsx'));
const OAuthPage = lazy(() => import('./pages/OAuthPage.jsx'));
// The design system's reference page; not linked anywhere.
const StyleguidePage = lazy(() => import('./pages/StyleguidePage.jsx'));

// Called once before the first render: starts downloading the code (and, when signed in, the
// data) the first screen needs, in parallel with the sign-in check, instead of one after the other
// (main chunk, then /auth/me, then the shell, then the page, then its data). Same promises and
// query keys as the real thing, so nothing is fetched twice.
export function warmRoute(path, queryClient) {
  if (path.startsWith('/report/')) { load.portal(); return; }
  if (path === '/tour' || (path === '/' && !tokenStore.get())) { load.landing(); return; }
  if (!tokenStore.get()) return;
  load.shell();
  queryClient.prefetchQuery({ queryKey: qk.projects, queryFn: () => api('/projects').then((d) => d.projects) });
  if (path === '/projects') { load.projects(); return; }
  const m = path.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (!m) return;
  const [, id, rest = ''] = m;
  queryClient.prefetchQuery({ queryKey: qk.project(id), queryFn: () => api(`/projects/${id}`).then((d) => d.project) });
  if (!rest || rest.startsWith('/tickets/')) {
    load.board();
    if (rest.startsWith('/tickets/')) load.drawer();
    // The same filters the board will start with (its layout is saved with the account; the last
    // copy of it is in the signed-in snapshot). "Sprint only" needs the sprint first, so it waits.
    let board = {};
    try { board = JSON.parse(localStorage.getItem('tessera.user'))?.preferences?.board ?? {}; } catch { /* none */ }
    if (!board.sprintOnly) {
      const params = { sort: 'rank', limit: '500', ...(board.mine && { assignee: 'me' }) };
      queryClient.prefetchQuery({ queryKey: qk.tickets(id, params), queryFn: () => api(`/projects/${id}/tickets?${new URLSearchParams(params)}`) });
    }
  }
  // Analytics is not warmed: its chart library is large, and fetching it before the first screen
  // paints only competes with the sign-in check on a slow connection.
}

const Loading = () => <div className="grid h-full min-h-60 place-items-center" role="status" aria-label="Loading"><Spinner className="size-6 text-fg-subtle" /></div>;

function RequireAuth({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

// The front door: the landing page for visitors, straight to the projects for people signed in.
function Home() {
  const { user } = useAuth();
  return user ? <Navigate to="/projects" replace /> : <LandingPage />;
}

function GuestOnly({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  return user ? <Navigate to={location.state?.from ?? '/projects'} replace /> : children;
}

// The first-load mark from index.html, already assembled (its fly-in has played by now).
function BootMark() {
  return (
    <div className="boot boot-still" role="status" aria-label="Loading Tessera">
      <svg width="44" height="44" viewBox="0 0 32 32" aria-hidden>
        <defs>
          <linearGradient id="boot-glass-still" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F7B23B" /><stop offset="0.48" stopColor="#F2557D" /><stop offset="1" stopColor="#8B6CF6" />
          </linearGradient>
        </defs>
        <g fill="url(#boot-glass-still)">
          <rect x="2" y="2" width="14" height="11" rx="3" /><rect x="18" y="2" width="12" height="17" rx="3" />
          <rect x="2" y="15" width="14" height="15" rx="3" /><rect x="18" y="21" width="12" height="9" rx="3" />
        </g>
      </svg>
    </div>
  );
}

export default function App() {
  const { ready } = useAuth();
  // While sign-in is checked: the same assembled mark the HTML drew, in the same place, held still.
  if (!ready) return <BootMark />;
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
        <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
        <Route path="/forgot" element={<GuestOnly><ForgotPasswordPage /></GuestOnly>} />
        {/* Links from emails: they work signed in or out. */}
        <Route path="/reset/:token" element={<ResetPasswordPage />} />
        <Route path="/verify/:token" element={<VerifyEmailPage />} />
        {/* Back from GitHub / Google sign-in. */}
        <Route path="/oauth" element={<OAuthPage />} />
        {/* Public: the bug-report page and invite links work without being signed in. */}
        <Route path="/report/:token" element={<PortalPage />} />
        <Route path="/status/:token" element={<StatusPage />} />
        <Route path="/track/:token" element={<TrackPage />} />
        <Route path="/roadmap/:token" element={<RoadmapPage />} />
        <Route path="/shared/:token" element={<SharedBoardPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<BoardPage />} />
          <Route path="/projects/:projectId/tickets/:ticketKey" element={<BoardPage />} />
          <Route path="/projects/:projectId/list" element={<ListPage />} />
          <Route path="/projects/:projectId/calendar" element={<CalendarPage />} />
          <Route path="/projects/:projectId/calendar/:ticketKey" element={<CalendarPage />} />
          <Route path="/projects/:projectId/timeline" element={<TimelinePage />} />
          <Route path="/projects/:projectId/triage" element={<TriagePage />} />
          <Route path="/projects/:projectId/errors/compare" element={<ComparePage />} />
          <Route path="/projects/:projectId/deploys" element={<DeploysPage />} />
          <Route path="/projects/:projectId/flow" element={<FlowPage />} />
          <Route path="/projects/:projectId/together" element={<TogetherPage />} />
          <Route path="/projects/:projectId/timeline/:ticketKey" element={<TimelinePage />} />
          <Route path="/projects/:projectId/sprints" element={<SprintsPage />} />
          <Route path="/projects/:projectId/sprints/:sprintId" element={<SprintReportPage />} />
          <Route path="/projects/:projectId/analytics" element={<AnalyticsPage />} />
          <Route path="/projects/:projectId/releases" element={<ReleaseNotesPage />} />
          <Route path="/projects/:projectId/settings" element={<SettingsPage />} />
          <Route path="/projects/:projectId/settings/audit" element={<AuditPage />} />
          <Route path="/my-work" element={<MyWorkPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/account" element={<AccountPage />} />
        </Route>
        <Route path="/styleguide" element={<StyleguidePage />} />
        <Route path="/" element={<Home />} />
        {/* The same page for anyone, signed in or not (linked from the README). */}
        <Route path="/tour" element={<LandingPage />} />
        {/* Anything else is a real "not here" page, so a wrong or stale link is noticed. */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
