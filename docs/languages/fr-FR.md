<div align="center">

# RXDev

**Générateur de commits Git par IA** — stage, génération, review, push en une commande.

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-4.1.0-8250df)](https://github.com/rxgodev/rxdev/releases)
[![CLI](https://img.shields.io/badge/cli-rxdev-4FC08D?logo=gnubash&logoColor=white)](.#readme)
[![License](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)
[![Groq](https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white)](https://console.groq.com)
[![Model](https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df)](.#readme)

[Documentation](https://github.com/rxgodev/rxdev#readme) · [Signaler un bug](https://github.com/rxgodev/rxdev/issues) ·
[English](https://github.com/rxgodev/rxdev/blob/main/README.md)

</div>

---

## Table des matières

- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
- [Démarrage rapide](#démarrage-rapide)
- [Commandes](#commandes)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Licence](#licence)

---

## Fonctionnalités

### 🚀 QuickFlow (`rxdev go`)

Le workflow phare. Une seule commande du répertoire de travail sale au commit poussé :

```
$ rxdev go
```

1. **Stage** — choisissez interactivement les fichiers à inclure
2. **Génération** — l'IA analyse le diff et diffuse un message Conventional Commit en temps réel
3. **Review** — voyez le message, choisissez la suite
4. **Push** — acceptez et poussez, ou modifiez, régénérez, annulez

QuickFlow élimine les changements de contexte. Fini le `git add → git commit → attendre → git push`. Tout se passe en une session fluide.

---

### Fonctionnalités principales

- **Messages de commit générés par IA** — un sujet en anglais au format Conventional Commits et un corps dans la langue de votre choix expliquant le *pourquoi*, dérivé de votre diff stagé. Prend en charge le français, l'anglais, le russe, l'allemand et le chinois.
- **Auto-incrémentation de version (optionnelle)** — détecte intelligemment les manifests de version dans tout le dépôt (compatible monorepo). Prend en charge 15+ formats :
  - `package.json`, `composer.json` — analyseur JSON
  - `Cargo.toml`, `pyproject.toml` — analyseur TOML
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - Détection automatique par nom de fichier ; aucune configuration requise.
  - `feat:` → incrémentation **mineure**, `!` / `BREAKING CHANGE` → **majeure**, tout le reste → **corrective**
  - Préserver les préversions — conserve les suffixes `-alpha.1`, `+build`.
  - Fusion sûr — lit les manifests déjà stagés depuis l'index.
  - Sensible aux changements — ignore l'incrémentation si les fichiers modifiés ne concernent pas le package.
  - Sensible aux tags Git — utilise le dernier tag semver si aucun manifest ne contient de version.
- **Modification avant commit** — consultez, régénérez ou ouvrez `$EDITOR` pour ajuster le message.
- **Multi-projets** — gérez les hooks et les modèles `prepare-commit-msg` partagés pour plusieurs dépôts depuis un seul endroit.
- **Liste d'exclusion** — `.commitignore` fonctionne comme `.gitignore` ; les fichiers correspondants sont exclus du diff envoyé au modèle.

---

## Installation

### Prérequis

- **Node.js** >= 18
- Une **clé API gratuite** depuis [console.groq.com](https://console.groq.com)

### 1. Configurer GitHub Package Registry

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Saisissez votre nom d'utilisateur GitHub et un [jeton d'accès personnel](https://github.com/settings/tokens) avec les droits `write:packages` (le jeton va dans le champ "Password").

### 2. Installer globalement

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

### 3. Configurer votre clé API

```bash
rxdev config
```

Naviguez jusqu'à **API key** dans le menu et collez votre clé Groq.

---

## Démarrage rapide

```bash
# Installez le hook (une fois par dépôt)
rxdev init

# QuickFlow — stage, génération, review, push
rxdev go
```

C'est tout. `rxdev go` vous guide à chaque étape :

1. **Choisissez les fichiers à staguer** — ou appuyez sur Entrée pour tous les stagner
2. **L'IA génère le message** — diffusé en direct dans votre terminal
3. **Boucle de review** — décidez de la suite :
   - **Push** — acceptez et poussez immédiatement
   - **Edit message** — ouvrez `$EDITOR` et modifiez
   - **Regenerate** — demandez une nouvelle suggestion au modèle
   - **Cancel** — reset logiciel et annulez
4. **Push** — spécifiez remote/branch ou acceptez les valeurs par défaut

> QuickFlow est le workflow recommandé. Pour l'intégration via hook Git (génération automatique via `git commit`), utilisez `rxdev init`.

---

## Commandes

| Commande          | Description |
|-------------------|-------------|
| `rxdev go`           | **QuickFlow** — stage → génération → review → push (recommandé) |
| `rxdev init`         | Installer le hook AI dans le dépôt courant |
| `rxdev config`       | Configurer clé API, modèle, langue, co-auteur, auto-incrémentation, projets et modèles |
| `rxdev status`       | Afficher l'état d'intégration du dépôt courant |
| `rxdev filter`       | Réécrire l'historique git — supprimer fichiers, secrets ou chemins via git-filter-repo |
| `rxdev uninstall`    | Supprimer le hook du dépôt |
| `rxdev version`      | Afficher la version |
| `rxdev update`       | Afficher les instructions de mise à jour |

---

## Configuration

```bash
rxdev config
```

### Paramètres

| Paramètre            | Description |
|----------------------|-------------|
| **Model**            | Choisir entre Llama 3.1 **8B** (plus rapide, ~560 t/s) et **70B** (plus intelligent, ~280 t/s) |
| **Language**         | Langue du corps du commit : français, anglais, russe, allemand ou chinois |
| **Custom prompt**    | Personnaliser le prompt système. Utilisez `{types}` comme placeholder — il sera remplacé par la liste des types autorisés (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert plus vos types personnalisés) |
| **Custom types**     | Ajouter des types Conventional Commits supplémentaires (ex. `hotfix, deps, i18n, ui, api, db`) |
| **API key**          | Définir ou effacer votre clé API Groq |
| **Co-author**        | Activer/désactiver le `Co-authored-by` dans les messages de commit |
| **Auto-bump**        | Activer/désactiver l'incrémentation automatique de version pour 15+ types de manifests (désactivé par défaut) |
| **Projects & Templates** | Lister les projets intégrés et gérer les modèles `prepare-commit-msg` partagés |

### .commitignore

Modifiez `.commitignore` (syntaxe identique à `.gitignore`) pour exclure des fichiers du diff envoyé au modèle. Par défaut, les entrées liées à `.githooks` y sont listées.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](../architecture.md) | Aperçu de l'architecture CLI Node.js + hook Node |
| [Auto-incrémentation](../auto-bump.md) | Incrémentation intelligente de version pour 15+ formats de manifest |
| [Modèles et projets](../templates.md) | Gestion multi-dépôts et modèles de hooks partagés |

---

## Licence

**MIT** — voir [LICENSE](../../LICENSE).
