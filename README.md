# Auto Commit System
Система создания AI-комментариев к коммитам

## Установка
1. Получите PAT-ключ от аккаунта по [ссылке](https://github.com/settings/tokens)
2. Залогиньтесь в `pnpm`: `pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/`
3. Введите свой юзернейм и токен (в поле пароль)
4. Получите ключ на https://ai.io.net/ai/api-keys
5. Установите пакет: `pnpm add -g @rxgodev/ac@latest`
6. Используйте `qq init` для создания хуков в директории проекта, либо `qq config` для установки ключа из п. 2
7. При необходимости, измените файл .commitignore (файлы оттуда не будут описываться)


## Использование
1. `git add .`
2. `git commit` OR `qq go` 
3. Прочитайте комментарий, при необходимости, добавьте или измените свои пункты
4. `:wq`
5. `git push`
