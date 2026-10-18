import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-GUIDE-1: SentinelGuide must guard against rendering on the login route
test("INV-GUIDE-1: SentinelGuide.tsx must inspect usePathname and identify login route", () => {
  const content = fs.readFileSync("src/components/SentinelGuide.tsx", "utf8");
  assert.ok(
    content.includes("usePathname"),
    "SentinelGuide must import and use usePathname from next/navigation"
  );
  assert.ok(
    content.includes("isLoginPage"),
    "SentinelGuide must define isLoginPage check"
  );
  assert.ok(
    content.includes('pathname === "/login"'),
    "SentinelGuide must check for /login route"
  );
});

// INV-GUIDE-2: SentinelGuide must prevent timers and auto-start on login or unauthenticated session
test("INV-GUIDE-2: SentinelGuide.tsx auto-start effect must halt on isLoginPage or unauthenticated", () => {
  const content = fs.readFileSync("src/components/SentinelGuide.tsx", "utf8");
  assert.match(
    content,
    /if\s*\(\s*isLoginPage\s*\|\|\s*!isAuthenticated\(\)\s*\)\s*\{\s*setShowAvatar\(false\);\s*setIsActive\(false\);\s*setShowTooltip\(false\);\s*return;\s*\}/,
    "SentinelGuide auto-start effect must exit early and reset states on login page or unauthenticated session"
  );
});

// INV-GUIDE-3: SentinelGuide must return null on login page or unauthenticated state
test("INV-GUIDE-3: SentinelGuide.tsx render output must return null on login page or unauthenticated state", () => {
  const content = fs.readFileSync("src/components/SentinelGuide.tsx", "utf8");
  assert.match(
    content,
    /if\s*\(\s*isLoginPage\s*\|\|\s*!showAvatar\s*\|\|\s*!isAuthenticated\(\)\s*\)\s*return null;/,
    "SentinelGuide render method must return null when on login page or unauthenticated"
  );
});
