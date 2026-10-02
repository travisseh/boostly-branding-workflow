#!/usr/bin/env python3
"""Write verified rich-text decision briefs to Apple Notes."""

from __future__ import annotations

import argparse
import html
import json
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


NOTES_DB = (
    Path.home()
    / "Library"
    / "Group Containers"
    / "group.com.apple.notes"
    / "NoteStore.sqlite"
)


def run_osascript(script: str, *args: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", script, *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Apple Notes automation failed")
    return result.stdout.strip()


def render_inline(text: str) -> str:
    """Escape text, then render the small supported inline Markdown subset."""
    escaped = html.escape(text, quote=False)
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escaped)
    escaped = re.sub(r"(?<!\w)_(.+?)_(?!\w)", r"<i>\1</i>", escaped)
    escaped = re.sub(
        r"\[([^\]]+)\]\((https?://[^)\s]+|notes://[^)\s]+)\)",
        r'<a href="\2">\1</a>',
        escaped,
    )
    return escaped


def markdown_to_notes_html(markdown: str) -> tuple[str, str]:
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    output: list[str] = []
    title = ""
    list_type: str | None = None

    def close_list() -> None:
        nonlocal list_type
        if list_type:
            output.append(f"</{list_type}>")
            list_type = None

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        if not stripped:
            close_list()
            if output and output[-1] != "<div><br></div>":
                output.append("<div><br></div>")
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            close_list()
            level = len(heading.group(1))
            text = render_inline(heading.group(2))
            plain = re.sub(r"<[^>]+>", "", text)
            if level == 1:
                title = title or html.unescape(plain)
                output.append(f"<h1>{text}</h1>")
            elif level == 2:
                output.append(f"<h2>{text}</h2>")
            else:
                output.append(f"<div><b>{text}</b></div>")
            continue

        bullet = re.match(r"^[-*]\s+(.+)$", stripped)
        numbered = re.match(r"^\d+[.)]\s+(.+)$", stripped)
        if bullet or numbered:
            desired = "ul" if bullet else "ol"
            if list_type != desired:
                close_list()
                list_type = desired
                output.append(f"<{list_type}>")
            item = bullet.group(1) if bullet else numbered.group(1)
            output.append(f"<li>{render_inline(item)}</li>")
            continue

        close_list()
        output.append(f"<div>{render_inline(stripped)}</div>")

    close_list()
    while output and output[-1] == "<div><br></div>":
        output.pop()

    if not title:
        raise ValueError("The brief must start with a '# Title' heading")
    return "\n".join(output), title


def find_note_id_by_title(title: str) -> str | None:
    script = """
on run argv
    set noteTitle to item 1 of argv
    tell application "Notes"
        set matchingNotes to notes whose name is noteTitle
        if (count of matchingNotes) is 0 then return "NOT_FOUND"
        if (count of matchingNotes) is greater than 1 then return "AMBIGUOUS"
        return id of item 1 of matchingNotes
    end tell
end run
"""
    result = run_osascript(script, title)
    if result == "NOT_FOUND":
        return None
    if result == "AMBIGUOUS":
        raise RuntimeError(f"Multiple Apple Notes have the title {title!r}; use --replace-id")
    return result


def create_note(title: str, body_html: str, folder: str) -> str:
    script = """
on run argv
    set noteTitle to item 1 of argv
    set htmlContent to item 2 of argv
    set folderName to item 3 of argv
    tell application "Notes"
        set targetAccount to default account
        set matchingFolders to folders of targetAccount whose name is folderName
        if (count of matchingFolders) is 0 then return "FOLDER_NOT_FOUND"
        set matchingNotes to notes of targetAccount whose name is noteTitle
        if (count of matchingNotes) is greater than 0 then return "ALREADY_EXISTS"
        set newNote to make new note at item 1 of matchingFolders with properties {name:noteTitle, body:htmlContent}
        return id of newNote
    end tell
end run
"""
    result = run_osascript(script, title, body_html, folder)
    if result == "FOLDER_NOT_FOUND":
        raise RuntimeError(f"Apple Notes folder {folder!r} was not found")
    if result == "ALREADY_EXISTS":
        raise RuntimeError(f"A note titled {title!r} already exists; use a replace option")
    return result


def replace_note(note_id: str, body_html: str) -> str:
    script = """
on run argv
    set noteIdentifier to item 1 of argv
    set htmlContent to item 2 of argv
    tell application "Notes"
        set matchingNotes to notes whose id is noteIdentifier
        if (count of matchingNotes) is 0 then return "NOT_FOUND"
        set body of item 1 of matchingNotes to htmlContent
        return id of item 1 of matchingNotes
    end tell
end run
"""
    result = run_osascript(script, note_id, body_html)
    if result == "NOT_FOUND":
        raise RuntimeError(f"Apple Note {note_id!r} was not found")
    return result


def read_note_body(note_id: str) -> str:
    script = """
on run argv
    set noteIdentifier to item 1 of argv
    tell application "Notes"
        set matchingNotes to notes whose id is noteIdentifier
        if (count of matchingNotes) is 0 then return "NOT_FOUND"
        return body of item 1 of matchingNotes
    end tell
end run
"""
    result = run_osascript(script, note_id)
    if result == "NOT_FOUND":
        raise RuntimeError(f"Apple Note {note_id!r} was not found after writing")
    return result


def note_pk(note_id: str) -> int | None:
    match = re.search(r"/ICNote/p(\d+)$", note_id)
    return int(match.group(1)) if match else None


def deep_link(note_id: str) -> str | None:
    pk = note_pk(note_id)
    if pk is None or not NOTES_DB.exists():
        return None
    for _ in range(10):
        try:
            with sqlite3.connect(f"file:{NOTES_DB}?mode=ro", uri=True) as conn:
                row = conn.execute(
                    "SELECT ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?",
                    (pk,),
                ).fetchone()
            if row and row[0]:
                return f"notes://showNote?identifier={row[0]}"
        except sqlite3.Error:
            pass
        time.sleep(0.2)
    return None


def verification(body_html: str) -> dict[str, int | bool]:
    counts = {
        "title_heading": len(
            re.findall(r"<h1(?:\s[^>]*)?>|font-size:\s*24px", body_html)
        ),
        "section_headings": len(
            re.findall(r"<h2(?:\s[^>]*)?>|font-size:\s*18px", body_html)
        ),
        "bold": len(re.findall(r"<b>", body_html)),
        "bullet_lists": len(re.findall(r"<ul>", body_html)),
        "numbered_lists": len(re.findall(r"<ol>", body_html)),
    }
    counts["verified"] = bool(
        counts["title_heading"]
        and counts["section_headings"]
        and counts["bold"]
        and (counts["bullet_lists"] or counts["numbered_lists"])
    )
    return counts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="Markdown file, or - for stdin")
    parser.add_argument("--folder", default="Notes", help="Apple Notes folder for creation")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--create", action="store_true", help="Create a new note; fail if title exists")
    mode.add_argument("--replace-id", help="Replace the note with this x-coredata ID")
    mode.add_argument("--replace-title", help="Replace the one note with this exact title")
    mode.add_argument("--preview", action="store_true", help="Print rendered HTML without writing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    markdown = sys.stdin.read() if args.input == "-" else Path(args.input).read_text()
    body_html, title = markdown_to_notes_html(markdown)

    if args.preview:
        print(body_html)
        return 0

    if args.create:
        note_id = create_note(title, body_html, args.folder)
        action = "created"
    else:
        note_id = args.replace_id
        if args.replace_title:
            note_id = find_note_id_by_title(args.replace_title)
            if note_id is None:
                raise RuntimeError(f"Apple Note {args.replace_title!r} was not found")
        note_id = replace_note(note_id, body_html)
        action = "updated"

    stored_body = read_note_body(note_id)
    result = {
        "action": action,
        "title": title,
        "note_id": note_id,
        "deep_link": deep_link(note_id),
        **verification(stored_body),
    }
    print(json.dumps(result, indent=2))
    return 0 if result["verified"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
