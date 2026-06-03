<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node version">
  <img src="https://img.shields.io/badge/version-2.15.3-8250df" alt="Version">
  <img src="https://img.shields.io/badge/cli-qq-4FC08D?logo=gnubash&logoColor=white" alt="CLI">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white" alt="Groq">
  <img src="https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df" alt="Llama 3.1/3.3">
</p>

# NeuroCommit

**KI-gestützter Generator für Conventional Commit Nachrichten** — analysiert Ihren staged Diff und erzeugt aussagekräftige, standardisierte Commit-Nachrichten über [Groq](https://console.groq.com) (basiert auf Meta Llama 3.1/3.3). Funktioniert als Git-Hook, interaktive CLI oder eigenständiger Generator.

<p align="center">
  <a href="https://github.com/rxgodev/ac-cli#readme"><b>Dokumentation</b></a>
  ·
  <a href="https://github.com/rxgodev/ac-cli/issues"><b>Fehler melden</b></a>
  ·
  <a href="https://github.com/rxgodev/neuro-commit/blob/main/README.md">English</a>
</p>

---

## Inhaltsverzeichnis

- [Funktionen](#funktionen)
- [Installation](#installation)
- [Schnellstart](#schnellstart)
- [Befehle](#befehle)
- [Konfiguration](#konfiguration)
- [Lizenz](#lizenz)

---

## Funktionen

- **KI-generierte Commit-Nachrichten** — ein Conventional Commits Betreff auf Englisch plus ein deutscher Body, der das *Warum* erklärt, basierend auf Ihrem staged Diff.
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
- **Bearbeiten vor dem Commit** — `qq go` ermöglicht das Prüfen, Neugenerieren oder Öffnen von `$EDITOR` zum Anpassen der Nachricht.
- **Multi-Projekt** — verwalten Sie Hooks und gemeinsame `prepare-commit-msg` Vorlagen für mehrere Repositories von einem Ort aus.
- **Ignorierliste** — `.commitignore` funktioniert wie `.gitignore`; passende Dateien werden vom Diff ausgeschlossen, der an das Modell gesendet wird.

---

## Installation

### Voraussetzungen

- **Node.js** >= 22
- Ein **kostenloser API-Schlüssel** von [console.groq.com](https://console.groq.com)

### 1. GitHub Package Registry einrichten

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Geben Sie Ihren GitHub-Benutzernamen und ein [persönliches Zugriffstoken](https://github.com/settings/tokens) mit `write:packages`-Berechtigung ein (das Token kommt in das Feld "Password").

### 2. Global installieren

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

### 3. API-Schlüssel konfigurieren

```bash
qq config
```

Navigieren Sie im Menü zu **API key** und fügen Sie Ihren Groq-Schlüssel ein.

---

## Schnellstart

```bash
# Installieren Sie den AI-Hook im aktuellen Repository
qq init

# Stagen Sie Dateien und committen Sie — die Nachricht wird automatisch generiert
git add .
git commit

# Oder nutzen Sie den geführten Ablauf
qq go
```

Der Befehl `qq go` führt Sie durch: Stage → Commit → Review → Push. Nach der Generierung der Nachricht haben Sie folgende Optionen:

- **Push** — akzeptieren und sofort pushen
- **Edit message** — `$EDITOR` öffnen und anpassen
- **Regenerate** — das Modell um einen neuen Vorschlag bitten
- **Cancel** — Soft-Reset und abbrechen

---

## Befehle

| Befehl         | Beschreibung |
|----------------|--------------|
| `qq init`      | Installiert den AI-Hook im aktuellen Repository |
| `qq go`        | Geführter Ablauf: Stage → Commit → Review → Push |
| `qq config`    | Konfiguriert API-Schlüssel, Modell, Co-Author, Auto-Bump, Projekte und Vorlagen |
| `qq status`    | Zeigt den Integrationsstatus des aktuellen Repositorys |
| `qq uninstall` | Entfernt den Hook aus dem Repository |

---

## Konfiguration

```bash
qq config
```

### Einstellungen

| Einstellung          | Beschreibung |
|----------------------|--------------|
| **Model**            | Wechsel zwischen Llama 3.1 **8B** (schneller, ~560 t/s) und **70B** (intelligenter, ~280 t/s) |
| **Custom prompt**    | System-Prompt überschreiben. Verwenden Sie `{types}` als Platzhalter — ersetzt durch die Liste erlaubter Typen (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert plus Ihre benutzerdefinierten Typen) |
| **Custom types**     | Fügen Sie zusätzliche Conventional Commits Typen hinzu (z.B. `hotfix, deps, i18n, ui, api, db`) |
| **API key**          | Groq API-Schlüssel setzen oder löschen |
| **Co-author**        | `Co-authored-by`-Trailer in Commit-Nachrichten ein-/ausschalten |
| **Auto-bump**        | Automatische Versionserhöhung für 15+ Manifesttypen ein-/ausschalten (standardmäßig aus) |
| **Projects & Templates** | Integrierte Projekte auflisten und gemeinsame `prepare-commit-msg` Vorlagen verwalten |

### .commitignore

Bearbeiten Sie `.commitignore` (Syntax wie `.gitignore`), um Dateien vom an das Modell gesendeten Diff auszuschließen. Standardmäßig sind dort `.githooks`-Einträge aufgeführt.

---

## Lizenz

**MIT** — siehe [LICENSE](./LICENSE).
