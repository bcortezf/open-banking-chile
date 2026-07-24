"""
AI PR Review - Security analysis for open-banking-chile

Analyzes each changed file in a PR for security issues:
- Hardcoded credentials
- Malicious/obfuscated code
- Data exfiltration attempts
- Command injection
- Dangerous file operations

Uses DeepSeek API + lightweight static analysis.
"""

import os
import json
import subprocess
import sys
import re

# ─── Config ──────────────────────────────────────────────────────────
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
PR_NUMBER = os.environ.get("PR_NUMBER", "")
REPO = os.environ.get("REPO", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

API_URL = "https://api.deepseek.com/chat/completions"

# ─── Static analysis (fast checks before AI) ────────────────────────

SUSPICIOUS_PATTERNS: list[tuple[str, str, str]] = [
    # (name, pattern, severity)
    ("hardcoded_password", r'(?i)(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["\']?(?!\*|\$|env|process\.env)', "high"),
    ("rut_sequence", r'(?i)(rut|run)\s*[:=]\s*["\']?\d{7,9}[-]?\d', "medium"),
    ("eval_usage", r'\b(eval|exec|execScript|Function)\s*\(', "high"),
    ("base64_strings", r'["\'][A-Za-z0-9+/]{40,}={0,2}["\']', "medium"),
    ("suspicious_url", r'["\']https?://(?!.*(bancochile|falabella|santander|bci|bancoestado|scotiabank|bice|itau|portalpersonas|portalempresas))[^"\']*\.(ru|cn|tk|ml|ga|cf|click|stream)\b', "high"),
    ("data_exfiltration", r'(?i)(xmlhttprequest|fetch|axios|request)\(.*["\']https?://(?!.*bancochile)', "high"),
    ("file_write_outside", r'(?i)(writeFile|writeFileSync|createWriteStream)\s*\(\s*["\'][^"\']*(?:\.\./|/tmp/|/etc/|/root/)', "medium"),
    ("subprocess_shell", r'(?i)(shell\s*=\s*True|exec\s*\(\s*["\']|subprocess\.(popen|call|run).*shell\s*=\s*True)', "high"),
    ("require_dynamic", r'(?i)(require|import)\s*\([^"\']', "medium"),
]


def static_analysis(diff_text: str, file_path: str) -> list[dict]:
    """Run regex-based static analysis on a diff."""
    findings = []
    for name, pattern, severity in SUSPICIOUS_PATTERNS:
        matches = re.finditer(pattern, diff_text)
        for m in matches:
            # Get surrounding context
            start = max(0, m.start() - 60)
            end = min(len(diff_text), m.end() + 60)
            context = diff_text[start:end].replace("\n", "⏎")

            findings.append({
                "file": file_path,
                "pattern": name,
                "severity": severity,
                "match": m.group()[:80],
                "context": context,
            })
    return findings


def get_pr_diff() -> str:
    """Get the full diff of the PR."""
    base_ref = os.environ.get('GITHUB_BASE_REF', 'main')
    # Try GitHub Actions merge commit first, then fallback to git diff
    result = subprocess.run(
        ["git", "diff", f"origin/{base_ref}...HEAD"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0 or not result.stdout.strip():
        # Fallback: diff against first parent (merge commit)
        result = subprocess.run(
            ["git", "diff", "HEAD~1...HEAD"],
            capture_output=True, text=True, timeout=30,
        )
    return result.stdout


def get_changed_files() -> list[str]:
    """Get list of changed files in the PR."""
    base_ref = os.environ.get('GITHUB_BASE_REF', 'main')
    result = subprocess.run(
        ["git", "diff", "--name-only", f"origin/{base_ref}...HEAD"],
        capture_output=True, text=True, timeout=15,
    )
    if result.returncode != 0 or not result.stdout.strip():
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD~1...HEAD"],
            capture_output=True, text=True, timeout=15,
        )
    return [f.strip() for f in result.stdout.split("\n") if f.strip()]


def ai_security_review(diff: str, static_findings: list[dict]) -> dict:
    """Send diff to DeepSeek for security analysis."""
    if not DEEPSEEK_API_KEY:
        return {"verdict": "skip", "reason": "No DeepSeek API key configured"}

    # Build prompt with static findings as context
    static_summary = ""
    if static_findings:
        static_summary = "⚠️ Static analysis flags:\n"
        for f in static_findings:
            static_summary += f"  - [{f['severity'].upper()}] {f['file']}: {f['pattern']} → {f['match']}\n"

    prompt = f"""Eres un revisor de seguridad para un proyecto open-source de banca chilena (scrapers bancarios en TypeScript).

Tu tarea es analizar el siguiente diff de código y determinar si contiene:

1. **Credenciales hardcodeadas** (passwords, RUTs reales, API keys, tokens)
2. **Código malicioso** (ofuscación, eval(), conexiones a servidores sospechosos)
3. **Exfiltración de datos** (envío de datos del usuario a servidores externos)
4. **Vulnerabilidades** (command injection, path traversal, falta de sanitización)

{static_summary}

El diff a analizar:

```diff
{diff[:8000]}
```

Responde EXACTAMENTE en este formato JSON (sin markdown, sin explicación extra):

{{
  "verdict": "approve" | "flag" | "review",
  "flags": [
    {{"severity": "high"|"medium"|"low", "file": "archivo.ts", "issue": "descripción corta", "line": número_estimado}}
  ],
  "summary": "Resumen de 1-2 líneas en español"
}}

Reglas:
- "approve": todo bien, sin issues de seguridad
- "flag": issues graves detectados (credenciales, malware, exfiltración)
- "review": dudas que requieren revisión humana (cosas raras pero no claramente maliciosas)
- Si el diff es solo docs/comentarios/README, siempre "approve"
"""

    try:
        import httpx
        resp = httpx.post(
            API_URL,
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-chat",
                "messages": [
                    {"role": "system", "content": "Eres un revisor de seguridad. Responde SOLO con JSON válido."},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 1000,
            },
            timeout=60,
        )

        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            # Extract JSON from response (handle markdown wrapping)
            json_match = re.search(r'\{.*\}', content, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
            return {"verdict": "review", "reason": "Could not parse AI response", "raw": content[:500]}
        else:
            return {"verdict": "error", "reason": f"API error: {resp.status_code}"}

    except Exception as e:
        return {"verdict": "error", "reason": str(e)}


def post_comment(body: str):
    """Post a comment on the PR."""
    if not GITHUB_TOKEN or not PR_NUMBER or not REPO:
        return

    import httpx
    try:
        url = f"https://api.github.com/repos/{REPO}/issues/{PR_NUMBER}/comments"
        httpx.post(
            url,
            headers={
                "Authorization": f"Bearer {GITHUB_TOKEN}",
                "Accept": "application/vnd.github.v3+json",
            },
            json={"body": body},
            timeout=15,
        )
    except Exception:
        pass


def main():
    diff = get_pr_diff()
    changed_files = get_changed_files()

    if not diff.strip():
        print("No diff to analyze.")
        return

    # 1. Static analysis
    static_findings = []
    for file_path in changed_files:
        if file_path.endswith((".md", ".txt", ".png", ".jpg", "LICENSE")):
            continue
        file_diff = subprocess.run(
            ["git", "diff", f"origin/{os.environ.get('GITHUB_BASE_REF', 'main')}...HEAD", "--", file_path],
            capture_output=True, text=True, timeout=15,
        ).stdout
        static_findings.extend(static_analysis(file_diff, file_path))

    # 2. AI analysis
    ai_result = ai_security_review(diff, static_findings)

    # 3. Build comment
    verdict = ai_result.get("verdict", "error")
    emoji = {"approve": "✅", "flag": "🚫", "review": "⚠️", "skip": "⏭️", "error": "🔴"}.get(verdict, "❓")

    comment_parts = [f"## {emoji} AI Security Review: {verdict.upper()}\n"]

    if static_findings:
        comment_parts.append("### 📋 Static analysis flags\n")
        for f in static_findings:
            comment_parts.append(f"- `[{f['severity'].upper()}]` {f['file']}: {f['pattern']}")
        comment_parts.append("")

    if ai_result.get("flags"):
        comment_parts.append("### 🤖 AI findings\n")
        comment_parts.append("| Severidad | Archivo | Issue |")
        comment_parts.append("|-----------|---------|-------|")
        for flag in ai_result["flags"]:
            sev = {"high": "🔴 Alta", "medium": "🟡 Media", "low": "🟢 Baja"}.get(flag.get("severity", "low"), flag["severity"])
            comment_parts.append(f"| {sev} | {flag.get('file', '?')} | {flag.get('issue', '?')} |")
        comment_parts.append("")

    if ai_result.get("summary"):
        comment_parts.append(f"> **Resumen:** {ai_result['summary']}\n")

    # Instructions based on verdict
    if verdict == "approve":
        comment_parts.append("---\n✅ Sin issues de seguridad detectados. **Pendiente revisión humana obligatoria** (prueba con cuenta real).")
    elif verdict == "flag":
        comment_parts.append("---\n🚫 **Se detectaron posibles issues de seguridad.** Un mantenedor revisará manualmente antes de continuar.")
    elif verdict == "review":
        comment_parts.append("---\n⚠️ Hay aspectos que requieren revisión humana. Un mantenedor evaluará.")

    comment_parts.append("\n> _La IA es un filtro auxiliar. No reemplaza las pruebas con cuentas bancarias reales ni la revisión por pares._")

    comment = "\n".join(comment_parts)

    # 4. Post to PR
    post_comment(comment)

    # 5. Print outcome for GitHub Actions
    print(f"Verdict: {verdict}")
    print(f"Findings: {len(static_findings) + len(ai_result.get('flags', []))}")
    print(comment)

    if verdict == "flag":
        sys.exit(1)  # Fail the CI check


if __name__ == "__main__":
    main()
