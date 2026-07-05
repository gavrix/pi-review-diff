# Pi Review Diff

A Pi extension that opens a local browser-based diff review UI for the current git working tree.

It lets you:

- open a GitHub-like diff page with `/review-diff`
- add line and range comments from the browser
- see pending comments in Pi's widget area
- inject pending comments into the next normal Pi prompt
- remove pending comments from the browser page
- refresh the diff when the page reloads, and after Pi agent turns finish
- switch between VS Code-inspired light and dark themes

## Install

```bash
pi install git:github.com/gavrix/pi-review-diff@v0.1.0
```

Then reload Pi resources:

```text
/reload
```

## Usage

In Pi, run:

```text
/review-diff
```

The extension starts a loopback-only HTTP server on `127.0.0.1` with an OS-assigned ephemeral port and opens the review page in your browser.

Add comments in the browser. Pending comments will be included automatically in the next normal prompt you send to Pi. Slash commands and bash commands are ignored.

## Security notes

This extension runs locally with the same permissions as Pi. It reads the current repository diff using git and serves it to a browser page on `127.0.0.1` only.

Review the source before installing any Pi package.
