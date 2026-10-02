#!/usr/bin/env python3
"""
Apple Notes CLI Tool
Usage: apple-notes.py [search|read|list] [query/id]
"""

import sqlite3
import sys
import gzip
import re
import html
from pathlib import Path
from datetime import datetime

DB_PATH = Path.home() / "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"

def get_connection():
    return sqlite3.connect(str(DB_PATH))

def decode_note_content(data_blob):
    """Decode the gzipped protobuf note content to plain text."""
    if not data_blob:
        return ""
    try:
        # Decompress gzip
        decompressed = gzip.decompress(data_blob)
        # Extract readable text (simplified - extracts ASCII/UTF-8 strings)
        # The protobuf structure has text in specific fields, but this works for most cases
        text = decompressed.decode('utf-8', errors='ignore')
        # Clean up non-printable characters but keep newlines
        text = re.sub(r'[^\x20-\x7E\n\r\t]', ' ', text)
        # Clean up excessive whitespace
        text = re.sub(r'  +', ' ', text)
        text = re.sub(r'\n\s*\n', '\n\n', text)
        return text.strip()
    except Exception as e:
        return f"[Error decoding: {e}]"

def convert_timestamp(ts):
    """Convert Apple's timestamp to readable date."""
    if ts:
        return datetime.fromtimestamp(ts + 978307200).strftime('%Y-%m-%d %H:%M:%S')
    return "Unknown"

def search_notes(query):
    """Search notes by title or content."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT Z_PK, ZTITLE1, ZMODIFICATIONDATE1, ZSNIPPET
        FROM ZICCLOUDSYNCINGOBJECT
        WHERE (ZTITLE1 LIKE ? OR ZSNIPPET LIKE ?)
        AND ZMARKEDFORDELETION = 0
        AND ZTITLE1 IS NOT NULL
        ORDER BY ZMODIFICATIONDATE1 DESC
        LIMIT 20
    """, (f'%{query}%', f'%{query}%'))

    results = cursor.fetchall()
    conn.close()

    if not results:
        print(f"No notes found matching '{query}'")
        return

    print(f"Found {len(results)} notes:\n")
    for pk, title, modified, snippet in results:
        print(f"ID: {pk}")
        print(f"Title: {title}")
        print(f"Modified: {convert_timestamp(modified)}")
        if snippet:
            print(f"Preview: {snippet[:100]}...")
        print()

def read_note(note_id):
    """Read full note content by ID."""
    conn = get_connection()
    cursor = conn.cursor()

    # Get note metadata
    cursor.execute("""
        SELECT ZTITLE1, ZMODIFICATIONDATE1
        FROM ZICCLOUDSYNCINGOBJECT
        WHERE Z_PK = ?
    """, (note_id,))
    meta = cursor.fetchone()

    if not meta:
        print(f"Note with ID {note_id} not found")
        conn.close()
        return

    title, modified = meta

    conn.close()

    print(f"Title: {title}")
    print(f"Modified: {convert_timestamp(modified)}")
    print(f"{'='*50}")

    note_html = get_note_body_html(title)
    if note_html:
        print(notes_html_to_text(note_html))
        return

    print("[No content available]")

def list_notes(limit=20):
    """List recent notes."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT Z_PK, ZTITLE1, ZMODIFICATIONDATE1
        FROM ZICCLOUDSYNCINGOBJECT
        WHERE ZTITLE1 IS NOT NULL AND ZMARKEDFORDELETION = 0
        ORDER BY ZMODIFICATIONDATE1 DESC
        LIMIT ?
    """, (limit,))

    results = cursor.fetchall()
    conn.close()

    print(f"Recent {len(results)} notes:\n")
    for pk, title, modified in results:
        print(f"{pk:>6} | {convert_timestamp(modified)} | {title}")

def text_to_notes_html(text):
    """Convert plain text into simple Apple Notes HTML that preserves line breaks."""
    blocks = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            blocks.append("<div><br></div>")
            continue

        if stripped.startswith("- "):
            escaped = "&bull; " + html.escape(stripped[2:].strip(), quote=False)
        else:
            escaped = html.escape(stripped, quote=False)

        blocks.append(f"<div>{escaped}</div>")

    return "\n".join(blocks)

def notes_html_to_text(note_html):
    """Convert Apple Notes HTML body to readable plain text."""
    text = note_html
    text = re.sub(r'</div>\s*<div>', '\n', text)
    text = re.sub(r'<div><br\s*/?></div>', '\n', text)
    text = re.sub(r'<br\s*/?>', '\n', text)
    text = re.sub(r'</?div[^>]*>', '', text)
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def run_notes_script(script, args):
    """Run AppleScript with argv so text does not need fragile inline escaping."""
    import subprocess
    result = subprocess.run(
        ['osascript', '-e', script, *args],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"Error: {result.stderr.strip()}")
        return None
    return result.stdout.strip()

def get_note_body_html(title):
    """Fetch note body from the Notes app instead of decoding the SQLite blob."""
    script = '''
    on run argv
        set noteTitle to item 1 of argv
        tell application "Notes"
            set matchingNotes to notes whose name is noteTitle
            if (count of matchingNotes) > 0 then
                return body of item 1 of matchingNotes
            else
                return "NOT_FOUND"
            end if
        end tell
    end run
    '''
    output = run_notes_script(script, [title])
    if output == "NOT_FOUND":
        return None
    return output

def append_to_note(title, text):
    """Append text to an existing note by title using AppleScript."""
    html_content = text_to_notes_html(text)

    script = '''
    on run argv
        set noteTitle to item 1 of argv
        set htmlContent to item 2 of argv
        tell application "Notes"
            set matchingNotes to notes whose name is noteTitle
            if (count of matchingNotes) > 0 then
                set theNote to item 1 of matchingNotes
                set noteBody to body of theNote
                set body of theNote to noteBody & "<div><br></div>" & htmlContent
                return "OK"
            else
                return "NOT_FOUND"
            end if
        end tell
    end run
    '''
    output = run_notes_script(script, [title, html_content])
    if output is None:
        return
    if output == "NOT_FOUND":
        print(f"Note '{title}' not found")
    else:
        print(f"Appended to '{title}'")

def prepend_to_note(title, text):
    """Insert text right after the title of a note (before existing content) using AppleScript."""
    html_content = text_to_notes_html(text)

    # Insert after the first </div> (which closes the title), before the rest of the body
    script = '''
    on run argv
        set noteTitle to item 1 of argv
        set htmlContent to item 2 of argv
        tell application "Notes"
            set matchingNotes to notes whose name is noteTitle
            if (count of matchingNotes) > 0 then
                set theNote to item 1 of matchingNotes
                set noteBody to body of theNote
                -- Find end of first div (the title)
                set titleEnd to offset of "</div>" in noteBody
                if titleEnd > 0 then
                    set beforeContent to text 1 thru (titleEnd + 5) of noteBody
                    set afterContent to text (titleEnd + 6) thru -1 of noteBody
                    set body of theNote to beforeContent & "<div><br></div>" & htmlContent & afterContent
                else
                    set body of theNote to noteBody & "<div><br></div>" & htmlContent
                end if
                return "OK"
            else
                return "NOT_FOUND"
            end if
        end tell
    end run
    '''
    output = run_notes_script(script, [title, html_content])
    if output is None:
        return
    if output == "NOT_FOUND":
        print(f"Note '{title}' not found")
    else:
        print(f"Prepended to '{title}'")

def set_note_body(title, text):
    """Replace a note body by title with formatted plain text."""
    html_content = text_to_notes_html(text)

    script = '''
    on run argv
        set noteTitle to item 1 of argv
        set htmlContent to item 2 of argv
        tell application "Notes"
            set matchingNotes to notes whose name is noteTitle
            if (count of matchingNotes) > 0 then
                set theNote to item 1 of matchingNotes
                set body of theNote to htmlContent
                return "OK"
            else
                return "NOT_FOUND"
            end if
        end tell
    end run
    '''
    output = run_notes_script(script, [title, html_content])
    if output is None:
        return
    if output == "NOT_FOUND":
        print(f"Note '{title}' not found")
    else:
        print(f"Set body for '{title}'")

def main():
    if len(sys.argv) < 2:
        print("Usage: apple-notes.py [search|read|list|append|prepend|set] [args]")
        print("  search <query>       - Search notes by title or content")
        print("  read <id>            - Read a specific note by ID")
        print("  list [limit]         - List recent notes (default 20)")
        print('  append <title> <text> - Append text to a note by title')
        print('  prepend <title> <text> - Prepend text to top of a note by title')
        print('  set <title> <text>    - Replace note body by title')
        sys.exit(1)

    command = sys.argv[1]

    if command == "search" and len(sys.argv) > 2:
        search_notes(sys.argv[2])
    elif command == "read" and len(sys.argv) > 2:
        read_note(int(sys.argv[2]))
    elif command == "list":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        list_notes(limit)
    elif command == "append" and len(sys.argv) > 3:
        append_to_note(sys.argv[2], sys.argv[3])
    elif command == "prepend" and len(sys.argv) > 3:
        prepend_to_note(sys.argv[2], sys.argv[3])
    elif command == "set" and len(sys.argv) > 3:
        set_note_body(sys.argv[2], sys.argv[3])
    else:
        print("Invalid command. Use search, read, list, append, prepend, or set.")

if __name__ == "__main__":
    main()
