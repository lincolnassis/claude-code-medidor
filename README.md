# Medidor: uso e progresso para o Claude Code

Um mod para o [Claude Code](https://claude.com/claude-code) que coloca, logo acima do campo do prompt, uma linha com tudo o que importa para não estourar o plano:

```
◆ Tarefa 2/4 ▰▰▱▱ 50% · ~4 min restantes · total ~9 min │ Semana ▰▰▱ 40% → 81% no fim │ 5h ▰▱▱ 23% ↻ 18:00 │ Mês US$ 12 → US$ 26 │ Contexto 34%
```

Feito para quem usa o plano Pro (ou Max) e precisa acompanhar de perto o limite semanal e a janela de 5 horas.

## O que ele mostra

| Parte | O que é |
| --- | --- |
| **Tarefa** | Progresso da lista de etapas que o Claude monta enquanto trabalha, com tempo restante e tempo total estimado. Passe o mouse na barra para ver a etapa atual. |
| **Semana** | % usado da janela semanal do plano. A parte "fantasma" da barra é a **projeção**: onde você chega quando a semana zerar, no ritmo atual. Se for estourar antes, mostra o dia e a hora. |
| **5h** | % usado da janela de 5 horas e o horário em que ela zera. |
| **Mês** | Custo equivalente do mês (quanto custaria pela API) e a projeção até o fim do mês. |
| **Contexto** | Quanto da janela de contexto desta conversa já está ocupado. |

As cores mudam sozinhas: verde até 60%, amarelo até 85%, vermelho acima disso.

### Alertas
Avisos na tela quando a semana passa de 50%, 75%, 90% e 100%, quando a janela de 5 horas passa de 80% e 95%, e quando o ritmo atual vai estourar a semana antes de ela zerar. Cada aviso aparece uma vez por janela.

### Painel `/gastos`
Digite `/gastos` (ou clique em **Detalhes** na barra) para abrir um painel com:

- os limites, quando cada um zera e quantos % por dia você ainda pode usar;
- a tarefa atual, etapa por etapa;
- custo e tokens de hoje, da semana e do mês, com a projeção do mês;
- gráfico dos últimos 30 dias;
- gasto por modelo (Opus, Sonnet, Haiku...) e por projeto;
- quanto você economizaria usando o Sonnet nas tarefas feitas no Opus.

## Não gasta tokens

O mod não chama nenhum modelo. Ele só lê dados que já estão no seu computador:

- **Limites do plano:** os percentuais que o próprio Claude Code recebe a cada resposta (janela de 5 horas e semanal).
- **Histórico:** os registros locais das conversas em `~/.claude/projects`, que incluem os tokens e o modelo de cada resposta. Assim o mês soma **todos** os chats deste computador: app desktop, VS Code e terminal.
- **Tarefa:** as chamadas que o Claude faz para atualizar a própria lista de etapas.

O valor em US$ é o preço de tabela da API para aqueles tokens. No plano Pro você não paga por token: o número serve para comparar o peso de cada modelo.

## Instalação

No terminal, dentro do Claude Code:

```
/plugin install medidor --marketplace lincolnassis/claude-code-medidor
```

Ou pelo shell:

```bash
claude plugin install medidor --marketplace lincolnassis/claude-code-medidor
```

No app desktop, onde `/plugin` não roda: clique no **+** ao lado do campo do prompt, depois em **Plugins**, **Add marketplace** com `lincolnassis/claude-code-medidor` e então **Add plugin**.

Instalado no escopo de usuário, ele aparece em todos os projetos e chats. No VS Code, que não tem a faixa acima do prompt, os números aparecem na linha de "trabalhando...".

## Como a estimativa de tempo funciona

1. Cada etapa concluída registra a hora em que terminou.
2. O ritmo da tarefa é o tempo médio por etapa concluída.
3. Enquanto poucas etapas terminaram, esse ritmo é misturado com a média das suas tarefas anteriores, que o mod aprende e guarda entre sessões.
4. Tempo restante = ritmo × etapas que faltam, descontando o tempo que a etapa atual já usou.

A projeção da semana é linear: % usado ÷ fração da semana que já passou.

## Estrutura do código

```
.claude-plugin/plugin.json   manifesto do mod
hooks/register.tsx           eventos: início da sessão, medições, turnos, ferramentas, desenho
hooks/task.ts                lê a lista de etapas e calcula a estimativa de tempo
hooks/ledger.ts              soma o histórico local por dia, modelo e projeto (com cache incremental)
hooks/view.tsx               formatação, projeções, barras em SVG, a faixa, o painel e a linha do VS Code
types/index.d.ts             tipos do estado do mod
tests/medidor.test.tsx       testes em todas as superfícies (desktop, terminal, VS Code, celular)
```

Escrito em TypeScript com a API de mods (function hooks) do Claude Code. Para rodar os testes:

```bash
claude plugin test .
```

## Limitações

- Os percentuais do plano chegam junto com cada resposta; numa sessão nova eles aparecem com o último valor conhecido até a primeira resposta.
- O histórico mensal é deste computador. Outro computador mostra o próprio uso (os percentuais do plano são os mesmos, porque são da conta).
- Conversas com registro acima de 4 MB não são lidas e aparecem como "grandes demais" no painel.

---

## English summary

**Medidor** is a Claude Code mod that adds a one-line band above the prompt with the current task's progress and estimated time left, the plan's 5-hour and weekly usage with a projection to the reset, the month's API-equivalent cost, and the context fill. It raises alerts before a limit runs out and opens a detailed report with `/gastos` (30-day chart, usage by model and project, Sonnet savings tip). It reads only local data and never calls a model, so it uses no tokens. Install with `/plugin install medidor --marketplace lincolnassis/claude-code-medidor`.

## Licença

MIT
