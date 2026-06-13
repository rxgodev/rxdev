<div align="center">

# RXDev

**KI-gestützter Git-Commit-Generator** — stage, generieren, prüfen, pushen in einem Befehl.

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-4.0.0-8250df)](https://github.com/rxgodev/rxdev/releases)
[![CLI](https://img.shields.io/badge/cli-rxdev-4FC08D?logo=gnubash&logoColor=white)](.#readme)
[![License](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)
[![Groq](https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white)](https://console.groq.com)
[![Model](https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df)](.#readme)

[Dokumentation](https://github.com/rxgodev/rxdev#readme) · [Fehler melden](https://github.com/rxgodev/rxdev/issues) ·
[English](https://github.com/rxgodev/rxdev/blob/main/README.md)

</div>

---

## Inhaltsverzeichnis

- [Funktionen](#funktionen)
- [Installation](#installation)
- [Schnellstart](#schnellstart)
- [Befehle](#befehle)
- [Konfiguration](#konfiguration)
- [Dokumentation](#dokumentation)
- [Lizenz](#lizenz)

---

## Funktionen

### 🚀 QuickFlow (`rxdev go`)

Der Flaggschiff-Workflow. Ein einziger Befehl vom schmutzigen Arbeitsverzeichnis zum gepushten Commit:

```
$ rxdev go
```

1. **Stage** — wählen Sie interaktiv Dateien zum Commit aus
2. **Generieren** — KI analysiert den Diff und streamt eine Conventional Commit Nachricht in Echtzeit
3. **Prüfen** — sehen Sie die Nachricht und wählen Sie die nächste Aktion
4. **Pushen** — akzeptieren und pushen, oder bearbeiten, neu generieren, abbrechen

QuickFlow eliminiert Kontextwechsel. Kein `git add → git commit → warten → git push` mehr. Alles in einer nahtlosen Sitzung.

---

### Kernfunktionen

- **KI-generierte Commit-Nachrichten** — ein Conventional Commits Betreff auf Englisch plus ein Body in Ihrer gewählten Sprache, der das *Warum* erklärt, basierend auf Ihrem staged Diff. Unterstützt Deutsch, Englisch, Russisch, Französisch und Chinesisch.
- **Auto-Bump Version (optional)** — erkennt intelligente Versionsmanifeste im gesamten Repository (Monorepo-tauglich). Unterstützt 15+ Formate:
  - `package.json`, `composer.json` — JSON-Parser
  - `Cargo.toml`, `pyproject.toml` — TOML-Parser
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - Automatische Erkennung anhand des Dateinamens; keine Konfiguration nötig.
  - `feat:` → **minor** Bump, `!` / `BREAKING CHANGE` → **major**, alles andere → **patch**
  - Pre-release-sicher — erhält `-alpha.1`, `+build` Suffixe.
  - Merge-sicher — liest bereits gestagte Manifeste aus dem Index.
  - Änderungsbewusst — überspringt den Bump, wenn geänderte Dateien nichts mit dem Paket zu tun haben.
  - Git-Tag-bewusst — fällt auf den letzten semver-Tag zurück, wenn kein Manifest existiert.
- **Bearbeiten vor dem Commit** — prüfen, neu generieren oder `$EDITOR` öffnen zum Anpassen der Nachricht.
- **Multi-Projekt** — verwalten Sie Hooks und gemeinsame `prepare-commit-msg` Vorlagen für mehrere Repositories von einem Ort aus.
- **Ignorierliste** — `.commitignore` funktioniert wie `.gitignore`; passende Dateien werden vom Diff ausgeschlossen, der an das Modell gesendet wird.

---

## Installation

### Voraussetzungen

- **Node.js** >= 18
- Ein **kostenloser API-Schlüssel** von [console.groq.com](https://console.groq.com)

### 1. GitHub Package Registry einrichten

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Geben Sie Ihren GitHub-Benutzernamen und ein [persönliches Zugriffstoken](https://github.com/settings/tokens) mit `write:packages`-Berechtigung ein (das Token kommt in das Feld "Password").

### 2. Global installieren

**npm:**
```bash
npm install -g @rxgodev/rxdev@latest
```

**pnpm:**
```bash
pnpm add -g @rxgodev/rxdev@latest
```

**yarn:**
```bash
yarn global add @rxgodev/rxdev@latest
```

### 3. API-Schlüssel konfigurieren

```bash
rxdev config
```

Navigieren Sie im Menü zu **API key** und fügen Sie Ihren Groq-Schlüssel ein.

---

## Schnellstart

```bash
# Hook installieren (einmal pro Repository)
rxdev init

# QuickFlow — stage, generieren, prüfen, pushen
rxdev go
```

Das ist alles. `rxdev go` führt Sie durch jeden Schritt:

1. **Dateien zum Stagen auswählen** — oder Enter drücken, um alle zu stagen
2. **KI generiert die Nachricht** — live in Ihr Terminal gestreamt
3. **Prüfschleife** — entscheiden Sie:
   - **Push** — akzeptieren und sofort pushen
   - **Edit message** — `$EDITOR` öffnen und anpassen
   - **Regenerate** — das Modell um einen neuen Vorschlag bitten
   - **Cancel** — Soft-Reset und abbrechen
4. **Pushen** — Remote/Branch angeben oder Standardwerte akzeptieren

> QuickFlow ist der empfohlene Workflow. Für die Git-Hook-Integration (automatische Generierung via `git commit`) verwenden Sie `rxdev init`.

---

## Befehle

| Befehl           | Beschreibung |
|------------------|--------------|
| `rxdev go`          | **QuickFlow** — Stage → Generieren → Prüfen → Pushen (empfohlen) |
| `rxdev init`        | Installiert den AI-Hook im aktuellen Repository |
| `rxdev config`      | Konfiguriert API-Schlüssel, Modell, Sprache, Co-Author, Auto-Bump, Projekte und Vorlagen |
| `rxdev status`      | Zeigt den Integrationsstatus des aktuellen Repositorys |
| `rxdev filter`      | Git-Verlauf umschreiben — Dateien, Secrets oder Pfade mit git-filter-repo entfernen |
| `rxdev uninstall`   | Entfernt den Hook aus dem Repository |
| `rxdev version`     | Zeigt die Version an |
| `rxdev update`      | Zeigt Update-Anleitung an |

---

## Konfiguration

```bash
rxdev config
```

### Einstellungen

| Einstellung          | Beschreibung |
|----------------------|--------------|
| **Model**            | Wechsel zwischen Llama 3.1 **8B** (schneller, ~560 t/s) und **70B** (intelligenter, ~280 t/s) |
| **Language**         | Sprache des Commit-Bodys: Deutsch, Englisch, Russisch, Französisch oder Chinesisch |
| **Custom prompt**    | System-Prompt überschreiben. Verwenden Sie `{types}` als Platzhalter — ersetzt durch die Liste erlaubter Typen (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert plus Ihre benutzerdefinierten Typen) |
| **Custom types**     | Fügen Sie zusätzliche Conventional Commits Typen hinzu (z.B. `hotfix, deps, i18n, ui, api, db`) |
| **API key**          | Groq API-Schlüssel setzen oder löschen |
| **Co-author**        | `Co-authored-by`-Trailer in Commit-Nachrichten ein-/ausschalten |
| **Auto-bump**        | Automatische Versionserhöhung für 15+ Manifesttypen ein-/ausschalten (standardmäßig aus) |
| **Projects & Templates** | Integrierte Projekte auflisten und gemeinsame `prepare-commit-msg` Vorlagen verwalten |

### .commitignore

Bearbeiten Sie `.commitignore` (Syntax wie `.gitignore`), um Dateien vom an das Modell gesendeten Diff auszuschließen. Standardmäßig sind dort `.githooks`-Einträge aufgeführt.

---

## Dokumentation

| Dokument | Beschreibung |
|----------|--------------|
| [Architektur](../architecture.md) | Überblick über die Node.js CLI + Node-Hook-Architektur |
| [Auto-Bump](../auto-bump.md) | Intelligente Versionserhöhung für 15+ Manifestformate |
| [Vorlagen und Projekte](../templates.md) | Multi-Repository-Verwaltung und gemeinsame Hook-Vorlagen |

---

## Lizenz

**MIT** — siehe [LICENSE](../../LICENSE).
