// Safety of AI-suggested commands. Pure, no runtime imports (node --test).
//
// - Nothing the AI suggests is ever run: it is inserted at the prompt, and the text inserted
//   never contains a line break unless the program asked for bracketed paste (then the whole
//   text is one paste, which shells insert without running). Control characters are removed,
//   so a reply can never smuggle an Enter or the end-of-paste sequence (ESC [201~).
// - Destructive commands are flagged with the reason, so the warning is visible before the
//   user inserts them.

/** Kinds of shell (store/workspaceModel.ts's ShellKind), redeclared to keep this module pure. */
export type InsertShell = 'powershell' | 'pwsh' | 'cmd' | 'gitbash' | 'wsl' | 'other' | null;

const RULES: readonly (readonly [RegExp, string])[] = [
  // Recursive deletes (bash, PowerShell and its aliases, cmd).
  [/\brm\s+(?:[^|;&\n]*\s)?-[a-zA-Z]*[rR][a-zA-Z]*\b/, 'borrado recursivo'],
  [/\brm\s+(?:[^|;&\n]*\s)?--recursive\b/, 'borrado recursivo'],
  [/\b(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^|;&\n]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b/i, 'borrado recursivo'],
  [/\b(?:rd|rmdir|del|erase)\b[^|;&\n]*\s\/s\b/i, 'borrado recursivo'],
  [/\b(?:Remove-Item|ri|rm|del|erase)\b[^|;&\n]*(?:\s|[\\/])\*(?:\.\*)?(?=\s|$|["'])/i, 'borra con comodín (*)'],
  [/\b(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b[^|;&\n]*\s(?:["']?[a-z]:\\?["']?(?=\s|$)|~[\\/]?(?=\s|$)|\/(?=\s|$)|\$HOME\b|\$env:USERPROFILE\b|%USERPROFILE%)/i, 'borra la raíz de un disco o la carpeta del usuario'],
  // git
  [/\bgit\s+reset\b[^|;&\n]*\s--hard\b/i, 'git reset --hard: descarta los cambios sin commitear'],
  [/\bgit\s+clean\b[^|;&\n]*\s-[a-zA-Z]*[fdxX]/, 'git clean: borra los archivos sin seguimiento'],
  [/\bgit\s+push\b[^|;&\n]*(?:\s--force(?:-with-lease|-if-includes)?\b|\s-[a-zA-Z]*f\b|\s\+[\w./-]+)/, 'git push --force: reescribe la historia remota'],
  [/\bgit\s+push\b[^|;&\n]*(?:\s--delete\b|\s-d\b|\s:[\w./-]+)/, 'borra una rama remota'],
  [/\bgit\s+branch\b[^|;&\n]*\s(?:-D|--delete\s+--force|-df|-fd)\b/, 'git branch -D: borra una rama aunque no esté fusionada'],
  [/\bgit\s+(?:checkout|restore)\b[^|;&\n]*\s(?:--\s+)?\.(?=\s|$)/, 'descarta los cambios locales'],
  [/\bgit\s+stash\s+(?:drop|clear)\b/, 'git stash drop/clear: borra cambios guardados'],
  [/\bgit\s+(?:filter-branch|filter-repo)\b/, 'reescribe la historia de git'],
  // Disks and file systems.
  [/\bformat(?:\.com)?\s+[a-z]:/i, 'formatea un disco'],
  [/\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|diskpart)\b/i, 'formatea o particiona discos'],
  [/\bmkfs(?:\.\w+)?\b|\bdd\s+[^|;&\n]*\bof=/, 'escribe directo sobre un disco'],
  [/\bcipher(?:\.exe)?\s+\/w\b/i, 'sobrescribe el espacio libre del disco'],
  // Windows registry.
  [/\breg(?:\.exe)?\s+(?:delete|add|import|restore|load|unload|copy)\b/i, 'cambia el registro de Windows'],
  [/\b(?:Remove|Set|New|Rename|Clear|Move|Copy)-Item(?:Property)?\b[^|;&\n]*\b(?:HK(?:LM|CU|CR|U|CC)|Registry::)/i, 'cambia el registro de Windows'],
  [/\bregedit(?:\.exe)?\s+\/s\b/i, 'cambia el registro de Windows'],
  // The system.
  [/\bshutdown(?:\.exe)?\s|\b(?:Restart|Stop)-Computer\b/i, 'apaga o reinicia el equipo'],
  [/\bbcdedit\b|\b(?:vssadmin|wbadmin)\s+delete\b/i, 'cambia el arranque o borra copias de seguridad'],
  [/\bSet-ExecutionPolicy\b[^|;&\n]*\b(?:Unrestricted|Bypass)\b/i, 'baja la política de ejecución de PowerShell'],
  [/\bchmod\s+(?:-R\s+)?[0-7]?777\b|\bchown\s+-R\b|\bicacls\b[^|;&\n]*\/(?:reset|grant)\b[^|;&\n]*\/t\b/i, 'cambia permisos en masa'],
  // Data and infrastructure.
  [/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, 'borra datos de una base de datos'],
  [/\bDELETE\s+FROM\s+[\w.[\]"`]+\s*(?:;|$|["'])/i, 'DELETE sin WHERE: borra todas las filas'],
  [/\bdocker\s+(?:system|volume|image|container|network|builder)\s+prune\b|\bdocker\s+volume\s+rm\b/i, 'borra recursos de Docker'],
  [/\bkubectl\s+delete\b/i, 'borra recursos de Kubernetes'],
  [/\bterraform\s+destroy\b|\bterraform\s+apply\b[^|;&\n]*-auto-approve\b/i, 'cambia o destruye infraestructura sin preguntar'],
  // Running code that is not in the command itself.
  [/\|\s*(?:iex|Invoke-Expression)\b|\b(?:iex|Invoke-Expression)\s*\(/i, 'ejecuta código descargado o generado'],
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, 'ejecuta un script descargado'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'bomba de procesos'],
];

/** Why a command is dangerous (empty if nothing was found). Each reason once. */
export function destructiveReasons(command: string): string[] {
  const reasons: string[] = [];
  for (const [re, reason] of RULES) {
    if (re.test(command) && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

/** A line that continues on the next one: PowerShell `, bash \, cmd ^, or an open pipe/block. */
const CONTINUES = /(?:[`\\^]|\||\{|\(|,|&&|\|\|)\s*$/;

/**
 * The text to put at the prompt. Never a control character; never a line break unless the
 * program reads it as a paste (bracketed paste), because a line break is Enter: it would run
 * the line. Several lines are joined into one for the shell instead.
 */
export function prepareInsert(command: string, shell: InsertShell, bracketed: boolean): string {
  const clean = command
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // C0 (ESC, CR, BEL...), DEL and C1 controls; \n is handled below.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/^\s*\n|\n\s*$/g, '')
    .trimEnd();
  if (!clean.includes('\n')) return clean;
  if (bracketed) return clean;
  const separator = shell === 'cmd' ? ' & ' : '; ';
  const lines = clean
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  let out = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (CONTINUES.test(out)) out = `${out.replace(/[`\\^]\s*$/, '').trimEnd()} ${line.trim()}`;
    else if (/^\s*[})]/.test(line)) out = `${out} ${line.trim()}`;
    else out = `${out}${separator}${line.trim()}`;
  }
  return out;
}
