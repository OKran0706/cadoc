import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// INV-WAVE-1: DynamicResourceWave component must exist with SVG wave rendering
test("INV-WAVE-1: DynamicResourceWave component must render pulsating SVG waves", () => {
  const content = fs.readFileSync("src/components/DynamicResourceWave.tsx", "utf8");
  assert.ok(
    content.includes("export function DynamicResourceWave") || content.includes("export const DynamicResourceWave"),
    "DynamicResourceWave component must be exported"
  );
  assert.ok(
    content.includes("<svg") && content.includes("<path") && (content.includes("linePath") || content.includes("d=")),
    "DynamicResourceWave must render SVG wave paths"
  );
  assert.ok(
    content.includes("requestAnimationFrame") || content.includes("setInterval"),
    "DynamicResourceWave must animate dynamically"
  );
});

// INV-WAVE-2: Infrastructure page must integrate DynamicResourceWave for CPU and Memory
test("INV-WAVE-2: src/app/infrastructure/page.tsx must integrate DynamicResourceWave for CPU and Memory", () => {
  const content = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    content.includes("DynamicResourceWave"),
    "Infrastructure page must import and render DynamicResourceWave"
  );
  assert.ok(
    content.includes('label="CPU"') || content.includes("label='CPU'"),
    "Infrastructure page must render CPU dynamic wave"
  );
  assert.ok(
    content.includes('label="Memory"') || content.includes("label='Memory'"),
    "Infrastructure page must render Memory dynamic wave"
  );
});

// INV-WAVE-3: ManagedInfrastructure must also integrate dynamic wave
test("INV-WAVE-3: ManagedInfrastructure.tsx must integrate DynamicResourceWave", () => {
  const content = fs.readFileSync("src/components/ManagedInfrastructure.tsx", "utf8");
  assert.ok(
    content.includes("DynamicResourceWave"),
    "ManagedInfrastructure must import and render DynamicResourceWave"
  );
});

// INV-WAVE-4: DynamicResourceWave must dynamically calculate and tick CPU uptime, not hardcode 07:14:22:05
test("INV-WAVE-4: DynamicResourceWave must dynamically format and tick CPU uptime without hardcoding", () => {
  const content = fs.readFileSync("src/components/DynamicResourceWave.tsx", "utf8");
  assert.ok(
    !content.includes('uptime = "07:14:22:05"'),
    "DynamicResourceWave must not default to hardcoded 07:14:22:05"
  );
  assert.ok(
    content.includes("formatTaskManUptime") || content.includes("secondsUp"),
    "DynamicResourceWave must dynamically format and tick uptime"
  );
  assert.ok(
    content.includes("displayUptime"),
    "DynamicResourceWave must render displayUptime"
  );
});

// INV-WAVE-5: DynamicResourceWave must initialize currentVal before accessing it in displayProcesses
test("INV-WAVE-5: DynamicResourceWave must declare currentVal before displayProcesses", () => {
  const content = fs.readFileSync("src/components/DynamicResourceWave.tsx", "utf8");
  const currentValIdx = content.indexOf("const [currentVal, setCurrentVal] = useState");
  const displayProcessesIdx = content.indexOf("const displayProcesses =");
  assert.ok(currentValIdx !== -1, "currentVal state must be declared");
  assert.ok(displayProcessesIdx !== -1, "displayProcesses must be declared");
  assert.ok(
    currentValIdx < displayProcessesIdx,
    "currentVal must be initialized before displayProcesses to prevent ReferenceError TDZ"
  );
});

// INV-WAVE-6: DynamicResourceWave and infrastructure page must render nothing when server is offline or has no data
test("INV-WAVE-6: DynamicResourceWave and infrastructure page must render nothing when server is offline or has no data", () => {
  const waveContent = fs.readFileSync("src/components/DynamicResourceWave.tsx", "utf8");
  assert.ok(
    waveContent.includes("!isOnline") && waveContent.includes("return null"),
    "DynamicResourceWave must return null when offline or data is missing"
  );

  const infraContent = fs.readFileSync("src/app/infrastructure/page.tsx", "utf8");
  assert.ok(
    infraContent.includes("hasTelemetry") && infraContent.includes("{hasTelemetry &&"),
    "Infrastructure page must guard DynamicResourceWave rendering with hasTelemetry check"
  );
});
