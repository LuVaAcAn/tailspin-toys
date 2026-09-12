import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();
const MAX_ISSUES = 100;

function runGh(args, cwd) {
    const command = process.platform === "win32" ? "gh.exe" : "gh";
    return execFileAsync(command, args, {
        cwd,
        maxBuffer: 2_000_000,
        shell: process.platform === "win32",
    });
}

async function getRepository(cwd) {
    const { stdout } = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
    const repository = stdout.trim();
    if (!repository) {
        throw new Error("Could not determine the current GitHub repository.");
    }
    return repository;
}

async function getIssues(cwd) {
    const repository = await getRepository(cwd);
    const { stdout } = await runGh([
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--limit",
        String(MAX_ISSUES),
        "--json",
        "number,title,body,url,labels,updatedAt,createdAt,assignees",
    ], cwd);
    const issues = JSON.parse(stdout);
    return issues.map((issue) => ({
        ...issue,
        labels: Array.isArray(issue.labels) ? issue.labels.map((label) => label.name).filter(Boolean) : [],
        assignees: Array.isArray(issue.assignees) ? issue.assignees : [],
    }));
}

function issueScore(issue) {
    const labels = issue.labels.map((label) => label.toLowerCase());
    let score = 0;
    if (labels.some((label) => /urgent|critical|blocker|p0|priority: high|high priority/.test(label))) score += 8;
    if (labels.some((label) => /bug|security|regression|broken/.test(label))) score += 4;
    if (labels.some((label) => /enhancement|feature|help wanted/.test(label))) score += 1;
    if (issue.assignees.length === 0) score += 2;

    const updatedAt = Date.parse(issue.updatedAt);
    const ageInDays = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 86_400_000 : 365;
    if (ageInDays <= 7) score += 3;
    else if (ageInDays <= 30) score += 1;

    return score;
}

function issueReason(issue) {
    const labels = issue.labels.map((label) => label.toLowerCase());
    const reasons = [];
    if (labels.some((label) => /urgent|critical|blocker|p0|priority: high|high priority/.test(label))) {
        reasons.push("high-priority label");
    }
    if (labels.some((label) => /bug|security|regression|broken/.test(label))) {
        reasons.push("risk or defect label");
    }
    if (issue.assignees.length === 0) reasons.push("no assignee");
    const updatedAt = Date.parse(issue.updatedAt);
    if (Number.isFinite(updatedAt) && (Date.now() - updatedAt) / 86_400_000 <= 7) {
        reasons.push("updated in the last 7 days");
    }
    return reasons.length > 0 ? reasons.join(", ") : "highest available triage score";
}

function prioritize(issues) {
    return [...issues]
        .map((issue) => ({ issue, score: issueScore(issue) }))
        .sort((a, b) => b.score - a.score || Date.parse(b.issue.updatedAt) - Date.parse(a.issue.updatedAt))
        .map(({ issue }) => ({ ...issue, reason: issueReason(issue) }));
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
            if (body.length > 20_000) {
                reject(new Error("Request body is too large."));
                request.destroy();
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character]);
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleDateString();
}

function renderCard(issue, featured) {
    const labels = issue.labels.map((label) => `<span class="label">${escapeHtml(label)}</span>`).join("");
    const description = issue.body?.trim() || "No description provided.";
    const extra = featured
        ? `<p class="why"><strong>Why it’s here:</strong> ${escapeHtml(issue.reason)}.</p>`
        : "";
    return `<article class="card${featured ? " featured" : ""}">
      <div class="card-topline"><span class="issue-number">#${issue.number}</span><span>Updated ${escapeHtml(formatDate(issue.updatedAt))}</span></div>
      <h3><a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.title)}</a></h3>
      <p class="description">${escapeHtml(description.slice(0, 320))}${description.length > 320 ? "…" : ""}</p>
      <div class="labels">${labels || '<span class="muted">No labels</span>'}</div>
      ${extra}
      <button type="button" class="attach" data-issue-number="${issue.number}">Add to current context</button>
    </article>`;
}

function renderBoard(data) {
    if (data.error) {
        return `<main><header><p class="eyebrow">Issue triage</p><h1>Kanban board</h1></header><section class="empty error"><h2>Couldn’t load issues</h2><p>${escapeHtml(data.error)}</p><button type="button" id="refresh">Try again</button></section></main>`;
    }

    const featured = data.issues.slice(0, 3);
    const remainder = data.issues.slice(3);
    return `<main>
      <header><div><p class="eyebrow">Issue triage</p><h1>Kanban board</h1><p class="lede">The three issues most likely to need attention are surfaced first. Attach any issue to bring its details into the current session.</p></div><button type="button" id="refresh">Refresh</button></header>
      <section class="section"><div class="section-heading"><h2>Needs attention now</h2><span>${featured.length} issue${featured.length === 1 ? "" : "s"}</span></div><div class="cards">${featured.length ? featured.map((issue) => renderCard(issue, true)).join("") : '<div class="empty">No open issues need attention.</div>'}</div></section>
      <section class="section"><div class="section-heading"><h2>Remaining open issues</h2><span>${remainder.length} issue${remainder.length === 1 ? "" : "s"}</span></div><div class="cards">${remainder.length ? remainder.map((issue) => renderCard(issue, false)).join("") : '<div class="empty">There are no additional open issues.</div>'}</div></section>
      <p id="status" role="status" aria-live="polite"></p>
    </main>`;
}

function renderHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Issue triage board</title><style>
      :root{color-scheme:light dark;--surface:color-mix(in srgb,var(--background-color-default,#fff) 94%,var(--text-color-default,#1f2328) 6%);--surface-strong:color-mix(in srgb,var(--background-color-default,#fff) 88%,var(--text-color-default,#1f2328) 12%);--shadow:color-mix(in srgb,var(--text-color-default,#1f2328) 12%,transparent)}
      *{box-sizing:border-box}body{margin:0;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font:var(--text-body-medium,14px)/var(--leading-body-medium,20px) var(--font-sans,system-ui,sans-serif)}main{max-width:1100px;margin:auto;padding:clamp(16px,3vw,32px)}header{align-items:end;border-bottom:1px solid var(--border-color-default,#d0d7de);display:flex;justify-content:space-between;gap:20px;margin-bottom:28px;padding-bottom:22px}.eyebrow{color:var(--true-color-blue,#0969da);font-size:12px;font-weight:600;letter-spacing:.08em;margin:0 0 8px;text-transform:uppercase}h1{font-size:clamp(28px,4vw,40px);line-height:1.1;margin:0}.lede{color:var(--text-color-muted,#59636e);margin:10px 0 0;max-width:65ch}.section{margin-top:28px}.section-heading{align-items:baseline;display:flex;gap:10px;margin-bottom:12px}.section-heading h2{font-size:18px;margin:0}.section-heading span,.muted,.card-topline{color:var(--text-color-muted,#59636e);font-size:12px}.cards{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.card{background:var(--surface);border:1px solid var(--border-color-default,#d0d7de);border-radius:12px;box-shadow:0 8px 20px var(--shadow);display:flex;flex-direction:column;padding:16px}.card.featured{border-color:color-mix(in srgb,var(--true-color-blue,#0969da) 48%,var(--border-color-default,#d0d7de))}.card-topline{display:flex;justify-content:space-between;gap:8px}.issue-number{color:var(--true-color-blue,#0969da);font-weight:600}h3{font-size:16px;line-height:1.35;margin:10px 0 8px}h3 a{color:inherit;text-decoration:none}h3 a:hover{text-decoration:underline}.description{color:var(--text-color-muted,#59636e);margin:0 0 12px;overflow-wrap:anywhere}.labels{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px}.label{background:var(--surface-strong);border:1px solid var(--border-color-default,#d0d7de);border-radius:999px;font-size:11px;padding:2px 7px}.why{background:color-mix(in srgb,var(--true-color-blue-muted,#ddf4ff) 65%,transparent);border-left:3px solid var(--true-color-blue,#0969da);font-size:12px;margin:0 0 14px;padding:8px 10px}.why strong{font-weight:600}.attach,header button{appearance:none;background:var(--true-color-blue,#0969da);border:1px solid var(--true-color-blue,#0969da);border-radius:7px;color:var(--color-white,#fff);cursor:pointer;font:inherit;font-weight:600;margin-top:auto;min-height:34px;padding:6px 11px}.attach:hover,header button:hover{filter:brightness(.9)}button:focus-visible,a:focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:2px}.empty{border:1px dashed var(--border-color-default,#d0d7de);border-radius:10px;color:var(--text-color-muted,#59636e);padding:18px}.empty h2{color:var(--text-color-default,#1f2328);font-size:16px;margin:0 0 6px}.error{border-color:var(--true-color-red,#cf222e)}#status{color:var(--text-color-muted,#59636e);margin-top:16px}@media(max-width:650px){header{align-items:start;flex-direction:column}}
    </style></head><body><div id="app"></div><script>
      const app=document.querySelector("#app");
      const request=async(path,options={})=>{const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error||"Request failed.");return data;};
      const load=async()=>{app.innerHTML='<main><p role="status" aria-live="polite">Loading issues…</p></main>';try{const data=await request("/api/issues");app.innerHTML=data.html;wire();}catch(error){app.innerHTML=${JSON.stringify(renderBoard({ error: "Unable to load issues." }))};const message=app.querySelector(".error p");if(message)message.textContent=error.message;wire();}};
      const wire=()=>{document.querySelector("#refresh")?.addEventListener("click",load);document.querySelectorAll(".attach").forEach((button)=>button.addEventListener("click",async()=>{const status=document.querySelector("#status");button.disabled=true;if(status)status.textContent="Adding issue to current context…";try{await request("/api/attach",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:Number(button.dataset.issueNumber)})});if(status)status.textContent="Issue added to the current context.";button.textContent="Added to context";}catch(error){if(status)status.textContent=error.message;button.disabled=false;}}));};
      load();
    </script></body></html>`;
}

async function startServer(cwd, session) {
    const server = createServer(async (request, response) => {
        try {
            if (request.url === "/api/issues" && request.method === "GET") {
                const issues = prioritize(await getIssues(cwd));
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ html: renderBoard({ issues }) }));
                return;
            }
            if (request.url === "/api/attach" && request.method === "POST") {
                const { number } = JSON.parse(await readRequestBody(request));
                const issues = await getIssues(cwd);
                const issue = issues.find((candidate) => candidate.number === number);
                if (!issue) throw new Error("That issue is no longer open or could not be found.");
                await session.send({
                    prompt: `Please help me work on GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body?.trim() || "No description provided."}\n\nIssue URL: ${issue.url}`,
                });
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(renderHtml());
        } catch (error) {
            response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : "The request failed." }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "issue-triage-board",
            displayName: "Issue triage board",
            description: "Prioritize open GitHub issues and attach one to the current session context.",
            actions: [
                {
                    name: "refresh_issues",
                    description: "Refresh the open issues and their triage ranking.",
                    handler: async () => ({ issues: prioritize(await getIssues(process.cwd())) }),
                },
                {
                    name: "attach_issue",
                    description: "Add an open GitHub issue's details to the current session context.",
                    inputSchema: {
                        type: "object",
                        properties: { number: { type: "integer", minimum: 1 } },
                        required: ["number"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const issue = (await getIssues(process.cwd())).find((candidate) => candidate.number === ctx.input?.number);
                        if (!issue) throw new CanvasError("issue_not_found", "That issue is no longer open or could not be found.");
                        await session.send({ prompt: `Please help me work on GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body?.trim() || "No description provided."}\n\nIssue URL: ${issue.url}` });
                        return { ok: true, number: issue.number };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(process.cwd(), session);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Issue triage board", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(resolve));
                }
            },
        }),
    ],
});
