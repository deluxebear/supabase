#!/usr/bin/env python3
"""Apply per-hunk resolutions. modes: theirs / custom (later)."""
import subprocess
import sys

sys.path.insert(0, "/tmp")

DECISIONS = {
    # path -> list of hunk resolutions in order ("theirs" or "ours")
    "apps/studio/components/interfaces/BranchManagement/CreateBranchModal.tsx": ["theirs"],
    "apps/studio/components/interfaces/ConnectSheet/ConnectConfigSection.tsx": ["theirs", "theirs"],
    "apps/studio/components/interfaces/ConnectSheet/ConnectStepsSection.tsx": ["MERGE", "theirs", "theirs"],
    "apps/studio/components/interfaces/ConnectSheet/PasswordEncodingNote.tsx": ["theirs", "theirs"],
    "apps/studio/components/interfaces/DiskManagement/ui/DiskSpaceBar.tsx": ["theirs"],
    "apps/studio/components/interfaces/Integrations/Marketplace/MarketplaceListRow.tsx": ["theirs"],
    "apps/studio/components/interfaces/Integrations/VercelGithub/ProjectLinker.tsx": ["MERGE", "theirs"],
    "apps/studio/components/layouts/AccessTokens/AccessTokensLayout.tsx": ["theirs"],
    "apps/studio/components/layouts/Navigation/ProductMenuBar.tsx": ["theirs"],
    "apps/studio/components/interfaces/ConnectSheet/content/steps/direct-connection/content.tsx": ["MERGE", "MERGE", "MERGE", "MERGE"],
    "apps/studio/components/interfaces/Database/Backups/DatabaseBackupsNav.tsx": ["MERGE", "MERGE"],
    "apps/studio/components/interfaces/Settings/Database/ConnectionPooling/ConnectionPooling.tsx": ["MERGE"],
    "apps/studio/components/layouts/Navigation/LayoutHeader/LayoutHeader.tsx": ["MERGE"],
    "apps/studio/components/layouts/ProjectSettingsLayout/SettingsMenu.utils.tsx": ["MERGE"],
    "apps/studio/components/ui/AIAssistantPanel/AIAssistantChatSelector.tsx": ["MERGE", "MERGE"],
    "apps/studio/components/ui/AIAssistantPanel/AIOnboarding.tsx": ["MERGE"],
    "apps/studio/lib/telemetry.tsx": ["MERGE"],
    "apps/studio/pages/new/[slug].tsx": ["MERGE", "MERGE", "theirs"],
    "apps/studio/pages/project/[ref]/functions/[functionSlug]/code.tsx": ["MERGE"],
}


def find_hunks(lines):
    spans = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("<<<<<<< ours(fork-features)"):
            m = i
            j = i + 1
            while not lines[j].startswith(">>>>>>>"):
                j += 1
            spans.append((m, j))
            i = j + 1
        else:
            i += 1
    return spans


def section(lines, start, end):
    """return (ours, base, theirs) text of block start..end"""
    j = start + 1
    while not lines[j].startswith("|||||||"):
        j += 1
    k = j + 1
    while lines[k] != "=======":
        k += 1
    m = k + 1
    while not lines[m].startswith(">>>>>>>"):
        m += 1
    return (
        "\n".join(lines[start + 1:j]) + "\n",
        "\n".join(lines[j + 1:k]) + "\n",
        "\n".join(lines[k + 1:m]) + "\n",
        m,
    )


for path, modes in DECISIONS.items():
    lines = open(path).read().splitlines()
    spans = find_hunks(lines)
    if len(spans) != len(modes):
        print(f"!! {path}: {len(spans)} hunks vs {len(modes)} decisions — SKIPPED")
        continue
    # resolve from last to first to keep indices valid
    for (start, end), mode in reversed(list(zip(spans, modes))):
        ours, base, theirs, close = section(lines, start, end)
        if mode == "theirs":
            repl = theirs.splitlines()
        elif mode == "ours":
            repl = ours.splitlines()
        else:
            continue
        lines[start:end + 1] = repl
    open(path, "w").write("\n".join(lines) + "\n")
    if not any(l.startswith("<<<<<<< ours(fork-features)") for l in lines):
        subprocess.run(["git", "add", "--", path], check=True)
        print(f"resolved+staged: {path}")
    else:
        print(f"partially resolved (MERGE hunks left): {path}")
