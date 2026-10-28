// Découpage d'une commande shell pour l'affichage de l'outil bash (#143).
import { abbreviate, isLong, parseShell, type Step } from '../src/shared/shell.ts';

const flat = (steps: Step[]): string[] => steps.map((s) => `${s.op}|${s.words.map((w) => `${w.kind}:${w.text}`).join(' ')}`);

describe('commande shell', () => {
  it('enchaînements &&, ||, ;, | et redirections', () => {
    const cmd = 'git add -A && git commit -q -m "Conversation : x. Closes #142" && git rebase origin/main 2>&1 | tail -1 && pnpm check >/dev/null 2>&1; echo check=$?';
    expect(flat(parseShell(cmd))).toEqual([
      '|command:git word:add option:-A',
      '&&|command:git word:commit option:-q option:-m string:"Conversation : x. Closes #142"',
      '&&|command:git word:rebase word:origin/main redirect:2>&1',
      '||command:tail option:-1',
      '&&|command:pnpm word:check redirect:> /dev/null redirect:2>&1',
      ';|command:echo word:check=$?',
    ]);
  });

  it('pas de découpe dans les guillemets, $(…), `…` et sous-shells', () => {
    const steps = parseShell(`echo 'a && b' "c; $(date | cut -c1) \`x|y\`" && (cd /tmp; ls) || { echo non; }`);
    expect(steps.map((s) => s.op)).toEqual(['', '&&', '||']);
    expect(steps[0]?.words.map((w) => w.text)).toEqual(['echo', "'a && b'", '"c; $(date | cut -c1) `x|y`"']);
    expect(steps[1]?.words).toEqual([{ kind: 'group', text: '(cd /tmp; ls)' }]);
  });

  it('heredoc : corps rattaché à sa commande', () => {
    const steps = parseShell("python3 - <<'EOF'\nprint('a; b')\nEOF\necho fin");
    expect(flat(steps)).toEqual(["|command:python3 option:- redirect:<< 'EOF' heredoc:print('a; b')\nEOF", '|command:echo word:fin']);
  });

  it('here-string <<< : pas un heredoc', () => {
    expect(flat(parseShell('grep foo <<< "$out"\necho done'))).toEqual(['|command:grep word:foo redirect:<<< "$out"', '|command:echo word:done']);
  });

  it('affectations, préfixes, commentaires, lignes continuées', () => {
    expect(flat(parseShell('FOO=1 sudo -E make \\\n  all # build'))).toEqual(['|assign:FOO=1 command:sudo option:-E command:make word:all comment:# build']);
  });

  it('commande mal formée : exception', () => {
    expect(() => parseShell('echo "non fermé')).toThrowError(SyntaxError);
  });

  it('mots longs abrégés', () => {
    const w = { kind: 'string' as const, text: `"${'x'.repeat(80)}"` };
    expect(isLong(w)).toBeTrue();
    expect(abbreviate(w)).toBe(`"${'x'.repeat(39)}…"`);
  });
});
