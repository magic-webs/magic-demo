import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

// The sample website must stay public: the remote browser visits it signed out.
const isPublic = createRouteMatcher(["/signin", "/sample(.*)"]);
const isSignInPage = createRouteMatcher(["/signin"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const authed = await convexAuth.isAuthenticated();
  if (isSignInPage(request) && authed) {
    return nextjsMiddlewareRedirect(request, "/");
  }
  // API routes do their own auth check and return 401 JSON instead of redirecting.
  if (!isPublic(request) && !request.nextUrl.pathname.startsWith("/api/") && !authed) {
    return nextjsMiddlewareRedirect(request, "/signin");
  }
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
