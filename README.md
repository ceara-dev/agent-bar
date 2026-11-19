# Agent Bar

Barra desktop (Electron) para descobrir e executar os agentes e comandos do
OpenCode do projeto e do usuário. O nome da pasta continua `atlas-bar/`, mas o
título exibido é **Agent Bar**.

## Como rodar

```bash
cd atlas-bar
npm install
npm start
```

O projeto OpenCode é o diretório pai de `atlas-bar/` por padrão. Para apontar
para outro projeto:

```bash
npm start -- --project /caminho/do/projeto
# ou
OPENCODE_PROJECT_DIR=/caminho/do/projeto npm start
```

Requisitos: Node.js 18+ e o CLI `opencode` no `PATH` (ou `OPENCODE_BIN`).

Se o Electron reclamar de instalação incompleta:

```bash
npm rebuild electron
# ou
node node_modules/electron/install.js
```

## Como os agentes são descobertos

A descoberta roda ao abrir o app, no botão **Recarregar**, e sempre que um
arquivo relevante muda via `fs.watch`.

### 1. Arquivos de agente

São lidos arquivos `.md`/`.mdx` em:

| Origem | Caminhos |
| --- | --- |
| Projeto | `.opencode/agent/` e `.opencode/agents/` |
| Global | `~/.config/opencode/agent/` e `~/.config/opencode/agents/` |
| Global legado | `~/.opencode/agent/` e `~/.opencode/agents/` |

O nome vem do frontmatter `name`; se não existir, usa o nome do arquivo sem
`.md`. Campos extraídos:

```yaml
---
name: atlas
description: Agente de planejamento
mode: primary        # primary | subagent | all
model: opencode-go/deepseek-v4
color: "#14B8A6"     # opcional; vira a cor do chip
icon: "🧭"           # opcional
---
```

`description` aceita escalar, `>-` e `|`. Frontmatter inválido não derruba a
barra: o agente aparece com o badge vermelho `!` e o aviso no tooltip/banner.

### 2. Configuração JSON/JSONC

São lidos, nesta ordem de existência:

- Projeto: `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`,
  `.opencode/opencode.jsonc`
- Global: `~/.config/opencode/opencode.json(c)` e
  `~/.opencode/opencode.json(c)`

A chave `agent` pode ser um objeto nome → definição ou uma lista com `name`.
Campos usados: `name`, `description`, `mode`, `model`, `color`, `icon`,
`hidden`/`disable`.

### 3. Agentes embutidos

O app tenta, nesta ordem:

1. `opencode agent list` (somente se a versão instalada tiver o subcomando e
   devolver JSON);
2. `opencode api get "/api/agent?location[directory]=<projeto>"`;
3. fallback local com `build` e `plan`.

Os embutidos entram com origem `embutido` e são os primeiros a serem
sobrescritos.

### Prioridade e deduplicação

```
projeto > global > embutido
```

Dentro da mesma origem, **arquivo de agente vence configuração JSON**. Se o
mesmo nome aparecer em mais de um lugar, o vencedor é o de maior prioridade; a
barra não mostra duplicatas.

### Comandos

Comandos vêm de:

- `.opencode/command/*.md` e `.opencode/commands/*.md` (projeto);
- `~/.config/opencode/command(s)/` e `~/.opencode/command(s)/` (global);
- chave `command` do `opencode.json(c)`, como string (template) ou objeto
  (`template`, `description`, `agent`, `argument-hint`).

O campo `agent` do frontmatter associa o comando ao agente. Comandos sem
agente, ou cujo agente não existe/está oculto, aparecem no grupo **Geral**.
Projeto vence global para comandos de mesmo nome.

### `agents.json` (opcional)

`atlas-bar/agents.json` serve **apenas** para sobrescrever a descoberta
automática:

```json
{
  "atlas": { "icon": "🧭", "color": "#14B8A6", "order": 1 },
  "cajueiro": { "hidden": true }
}
```

Sem esse arquivo, tudo vem da descoberta. Veja `agents.json.example`.

### Atualização em tempo real

`fs.watch` observa as pastas de agentes/comandos, os `opencode.json(c)` e o
`agents.json`. Um debounce de 400 ms evita múltiplas descobertas seguidas. O
botão **Recarregar** força a leitura.

## Servidor e tempo real

O caminho principal é um servidor `opencode serve` próprio, iniciado e
encerrado junto com o app:

1. o app encontra uma porta livre e roda
   `opencode serve --hostname 127.0.0.1 --port <porta>` no projeto atual;
2. lê do stdout a URL e a senha e autentica com HTTP Basic
   (`opencode:<senha>`);
3. assina `GET /api/event` (SSE), com reconexão automática e `Last-Event-ID`;
4. cria sessões com `POST /api/session`, envia prompt com
   `POST /api/session/{id}/prompt`, comando com
   `POST /api/session/{id}/command`, interrompe com
   `POST /api/session/{id}/interrupt` e lista mensagens com
   `GET /api/session/{id}/message`.

Os eventos SSE alimentam Atividade, Histórico, status ao vivo e a Reunião. Se
o servidor não estiver disponível, o app mantém o fallback por
`opencode run` com spawn.

### Execução

- Prompt livre: sessão criada com `agent` e `POST /prompt`.
- Comando: sessão criada com `agent` e `POST /command`
  (`{ name, text }`), sem depender de `--command` no CLI.
- Grupo **Geral**: sessão sem `agent` explícito.
- Fallback: `opencode run --agent <nome> "<prompt>"`; para comando, expande o
  template (`$ARGUMENTS`/`$1..$9`) quando o CLI não tem `--command`.

Cada execução ganha um `executionId` e um `sessionId`, status individual
(`ocioso`, `rodando`, `concluído`, `erro`) e log separado. Agentes diferentes
podem rodar ao mesmo tempo; o mesmo agente no mesmo projeto só aceita uma
execução por vez. O botão **Parar** interrompe a sessão no servidor.

## Histórico

Os dados ficam em `atlas-bar/data/history/`:

- um `.jsonl` por sessão, com prompt, respostas, ferramentas, arquivos,
  permissões, erros e status;
- `index.json` com resumo (agente, projeto, início, fim, status, ações,
  arquivos, reunião vinculada).

O histórico é restaurado na abertura do app. A aba **Histórico** do agente
lista sessões e permite **Retomar sessão**, **Exportar como Markdown**,
**Copiar** e **Apagar**. O botão **Histórico** na barra superior abre a linha
do tempo unificada com filtros por agente, projeto, status e período, além de
busca por texto/arquivo.

Configuração em `settings.json` (opcional):

```json
{
  "history": { "retentionDays": 90, "maxSessionBytes": 5242880 },
  "meeting": { "maxAgents": 4, "maxRounds": 3, "turnTimeoutMs": 600000 },
  "server": { "startupTimeoutMs": 20000, "restartAttempts": 3 }
}
```

Sessões acima de `maxSessionBytes` são marcadas como truncadas; a retenção
padrão é de 90 dias. Veja `settings.example.json`.

## Reunião

Cada agente tem a aba **Reunião**, onde ele é o anfitrião. O anfitrião pode
adicionar outros agentes descobertos, definir pauta/projeto, salvar e carregar
modelos reutilizáveis.

### Delegação

O anfitrião recebe a pauta e a lista de participantes e usa o mecanismo nativo
do OpenCode (subagente / `@agente`, sessões filhas via `parentID`) para
delegar. Participantes com `mode: primary` não podem ser delegados: a
interface avisa e sugere a mesa-redonda.

### Mesa-redonda

O app orquestra turnos sobre um transcript compartilhado. Configurações:
ordem fixa ou decidida pelo anfitrião, máximo de rodadas (padrão 3) e parada
quando o anfitrião responde "CONCLUÍDO" ou quando o limite é atingido. O
moderador pode intervir, pausar, retomar, pular a vez, adicionar ou remover
participantes durante a reunião.

Ao final, o anfitrião gera a ata (decisões, pendências, responsáveis e
arquivos alterados), salva em
`atlas-bar/data/reunioes/<data>-<anfitriao>-<id>.md` e vincula ao histórico.
Modelos ficam em `data/reunioes/models.json`.

Concorrência e segurança:

- limite padrão de 4 agentes simultâneos (`meeting.maxAgents`);
- limite de rodadas e de turnos evita loop infinito;
- permissões de cada agente são respeitadas; a reunião nunca eleva `edit` ou
  `bash`;
- conflitos de escrita no mesmo arquivo geram aviso na interface;
- pedidos de permissão aparecem na barra de permissões para decisão manual.

## Specs, Hooks e Steering

As abas **Specs**, **Hooks** e **Steering** (atalhos **Alt+2/3/4**; **Alt+1** volta
para Agentes) usam o mesmo formato de arquivos do Kiro, em `.kiro/` na raiz do
projeto. Esses arquivos podem ir para o Git; a autorização de hooks fica em
`atlas-bar/data/` e não vai.

### Steering

Documentos Markdown com as regras do projeto, incluídos no texto dos prompts
enviados pelo Agent Bar (prompt livre, specs, hooks e geração de steering).
Comandos `/` não recebem steering, porque o texto deles são só os argumentos.

| Local | Caminho |
| --- | --- |
| Projeto | `.kiro/steering/*.md` |
| Global | `~/.kiro/steering/*.md` (o do projeto vence se tiver o mesmo nome) |

```yaml
---
inclusion: always          # always (padrão) | fileMatch | manual
fileMatchPattern: "API/**/*.php"   # só para fileMatch; aceita lista ["a", "b"]
---
```

- `always`: entra em todo prompt.
- `fileMatch`: entra quando um arquivo do contexto casa com o padrão: caminhos
  citados no prompt, arquivos que dispararam o hook ou arquivos da spec. Quando
  não entra, o agente recebe um índice com o caminho do documento para ler se
  precisar.
- `manual`: entra quando o prompt cita `#nome-do-arquivo`.
- `#[[file:caminho/relativo]]` dentro do documento inclui o conteúdo do arquivo
  (só dentro do projeto, até 50 KB).

O botão **Gerar com o agente** pede a um agente `product.md`, `tech.md` e
`structure.md`. **Simular inclusão** mostra o que entraria num prompt de exemplo.
O histórico registra quais documentos foram incluídos em cada execução.

### Specs

Desenvolvimento guiado por especificação em `.kiro/specs/<nome>/`:

1. **Requisitos** (`requirements.md`): histórias de usuário e critérios de
   aceitação em notação EARS (QUANDO… ENTÃO o sistema DEVE…).
2. **Design** (`design.md`): arquitetura, componentes, dados, erros e testes.
3. **Tarefas** (`tasks.md`): checklist `- [ ] 1. …` / `- [ ] 1.1 …`, com
   `_Requisitos: 1.1_` e `- [ ]*` para opcionais.
4. **Implementação**: execute uma tarefa (**▶ Executar**), a próxima ou todas em
   sequência.

O agente escolhido escreve cada fase; você revisa, pede ajustes (**Refinar com
o agente**) e aprova antes da próxima. Se um documento mudar depois de aprovado,
a fase aparece como "alterado após aprovar". Reabrir uma fase reabre as
seguintes.

Ao executar uma tarefa, o Agent Bar marca `[-]` no `tasks.md`, envia ao agente
só aquela tarefa com o contexto da spec e marca `[x]` quando a execução termina
com sucesso (ou volta para `[ ]` se falhar ou for interrompida). Quando todas as
subtarefas obrigatórias terminam, a tarefa-pai é concluída. "Executar todas"
para no primeiro erro e espera o agente ficar livre se outro trabalho (por
exemplo, um hook) estiver usando ele. O estado do Agent Bar fica em
`.config.kiro`, na chave `agentBar`.

### Hooks

Arquivos JSON `.kiro/hooks/<nome>.kiro.hook`:

```json
{
  "enabled": true,
  "name": "Atualizar testes",
  "description": "Ao salvar um arquivo Dart, ajusta os testes",
  "version": "1",
  "when": { "type": "fileEdited", "patterns": ["APP/lib/**/*.dart"] },
  "then": { "type": "askAgent", "prompt": "Atualize os testes do arquivo alterado.", "agent": "build" }
}
```

| `when.type` | Quando dispara |
| --- | --- |
| `fileEdited` / `fileCreated` / `fileDeleted` | arquivo que casa com `patterns` foi salvo, criado ou apagado |
| `promptSubmit` | antes de cada prompt do usuário: `askAgent` anexa as instruções; `runCommand` anexa a saída (limite de 30 s) |
| `agentStop` | depois que uma execução termina (não dispara para execuções de hooks nem para as interrompidas) |
| `userTriggered` | só pelo botão **Executar agora** |

`then.type` é `askAgent` (`prompt`, e `agent` opcional, uma extensão do Agent Bar)
ou `runCommand` (`command`, e `timeoutMs` opcional). O comando roda no shell do
sistema, na raiz do projeto, com `AGENT_BAR_FILES`, `AGENT_BAR_TRIGGER` e
`AGENT_BAR_HOOK` no ambiente.

Proteções:

- um hook criado ou alterado fora da interface só roda depois de **Autorizar**
  (o hash de `when` + `then` fica em `data/hooks-trust.json`). Assim, nem um
  repositório clonado nem um agente sem permissão de bash conseguem criar um
  hook que execute comandos sozinho;
- eventos de arquivo são agrupados (1,5 s) e as mudanças feitas enquanto o
  próprio hook roda não o disparam de novo;
- acima de `hooks.maxRunsPerMinute` execuções por minuto, os hooks automáticos
  pausam por 1 minuto;
- se o agente estiver ocupado, o hook espera até 10 minutos;
- só são observadas as pastas-base dos padrões, ignorando `node_modules`,
  `vendor`, `build`, `.dart_tool`, `.git` etc. (limite `hooks.maxWatchedDirs`).

Configuração em `settings.json`:

```json
{
  "steering": { "enabled": true, "maxChars": 60000 },
  "hooks": { "enabled": true, "debounceMs": 1500, "maxRunsPerMinute": 12, "commandTimeoutMs": 120000, "maxWatchedDirs": 5000 }
}
```

## Interface

- Chips por agente, com rolagem horizontal; subagentes em grupo separado.
- Badges de origem (`projeto`/`global`/`embutido`) e tipo
  (`primary`/`subagent`/`all`).
- Indicador ao vivo no card: ponto animado e texto como “respondendo”,
  “editando arquivo” ou “rodando bash”.
- Busca rápida por agente ou comando em **Ctrl/Cmd+K**.
- Favoritos (estrela) persistidos em `localStorage` e fixados no início.
- Painel do agente com abas **Atividade | Histórico | Reunião**.
- **Atividade:** linha do tempo em streaming, ferramentas recolhíveis, arquivos
  clicáveis e botão **Parar**.
- **Histórico:** sessões do agente, reprodução completa e ações de retomar,
  exportar, copiar e apagar.
- **Histórico geral:** linha do tempo unificada com filtros e busca.
- **Reunião:** montagem, execução e ata.
- Estado vazio com instruções quando nenhum agente é encontrado.
- Banner de avisos para frontmatter/configuração inválidos.

## Segurança

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- preload mínimo expondo apenas as APIs de descoberta, execução, histórico,
  reunião, permissão e abertura de arquivo
- execução via servidor local autenticado (Basic `opencode:<senha>`) ou, no
  fallback, via `spawn` com array de argumentos (`shell: false`)
- nomes de agente/comando validados contra a descoberta antes de executar
- permissões `ask` nunca são autoaprovadas; a decisão é sempre do usuário
- abertura de arquivos restrita ao projeto e a `atlas-bar/data/`
- servidor encerrado junto com o app; SSE reconecta sozinho
- CSP restritiva na página; navegação e `window.open` bloqueados

## Diferenças de versão do OpenCode

Testado com **OpenCode v2.3.2**:

| Recurso | v2.3.2 | Comportamento do Agent Bar |
| --- | --- | --- |
| `opencode serve` | existe | inicia servidor local com porta livre e senha |
| `GET /api/event` | existe | SSE com reconexão e `Last-Event-ID` |
| `POST /api/session` | existe | cria sessão com `agent`, `location` e `parentID` |
| `POST /api/session/{id}/prompt` | existe | prompt livre |
| `POST /api/session/{id}/command` | existe | comando com `{ name, text }` |
| `POST /api/session/{id}/interrupt` | existe | botão **Parar** |
| `parentID` em sessão | existe | subagente/sessão filha com relatório ao pai |
| `opencode agent list` | não existe | tenta; se falhar, usa `opencode api /api/agent` |
| `opencode run --command` | não existe | servidor usa `/command`; fallback expande o template |

Se uma versão futura adicionar `--command` ou `opencode agent list`, o app
continua funcionando: o servidor é sempre preferido e o fallback detecta as
flags do CLI.

## Estrutura

```
atlas-bar/
  main.js              processo principal, IPC, servidor, SSE e fs.watch
  preload.js           ponte mínima e segura
  lib/
    discovery.js       descoberta de agentes/comandos e prioridade
    frontmatter.js     parser de frontmatter
    jsonc.js           parser de JSONC
    runner.js          fallback via opencode run
    server.js          opencode serve + cliente SSE
    api.js             cliente HTTP da API do OpenCode
    history.js         JSONL por sessão + index.json
    meeting.js         delegação, mesa-redonda, atas e modelos
    settings.js        settings.json e defaults
    steering.js        .kiro/steering: inclusão always/fileMatch/manual
    specs.js           .kiro/specs: fases, tasks.md e execução de tarefas
    hooks.js           .kiro/hooks: gatilhos, ações, autorização e limites
    watcher.js         observador recursivo que ignora pastas pesadas
    glob.js            padrões ** * ? {a,b} [abc]
  renderer/
    index.html
    styles.css
    app.js
    kiro.js            telas de Specs, Hooks e Steering
  data/
    history/           histórico persistido (criado em runtime)
    reunioes/          atas e modelos de reunião
    exports/           exportações Markdown
  test/                testes de frontmatter, JSONC, runner, descoberta, histórico, settings, reunião,
                       glob, steering, specs, hooks e watcher
  agents.json.example
  settings.example.json
```

## Testes

```bash
cd atlas-bar
npm test
npm run check
```
# agent-bar
