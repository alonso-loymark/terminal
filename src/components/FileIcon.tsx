import {
  AppWindow,
  BookOpenText,
  Bot,
  Container,
  File,
  FileArchive,
  FileAudio,
  FileBadge,
  FileBox,
  FileBraces,
  FileChartPie,
  FileCode,
  FileCodeCorner,
  FileCog,
  FileDatabase,
  FileDigit,
  FileImage,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderArchive,
  FolderBookmark,
  FolderCheck,
  FolderCode,
  FolderCog,
  FolderGit2,
  FolderOpen,
  FolderOutput,
  FolderSymlink,
  GitBranch,
  Package,
  type LucideIcon,
} from 'lucide-react';
import { fileIcon, folderIcon, type FileIconId } from '../lib/fileIcons';

const ICONS: Record<FileIconId, LucideIcon> = {
  file: File,
  'file-code': FileCode,
  'file-markup': FileCodeCorner,
  'file-terminal': FileTerminal,
  'file-braces': FileBraces,
  'file-cog': FileCog,
  'file-key': FileKey,
  'file-lock': FileLock,
  'file-text': FileText,
  'file-spreadsheet': FileSpreadsheet,
  'file-slides': FileChartPie,
  'file-image': FileImage,
  'file-archive': FileArchive,
  'file-video': FileVideo,
  'file-audio': FileAudio,
  'file-font': FileType,
  'file-binary': FileDigit,
  'file-project': FileBox,
  'file-database': FileDatabase,
  'file-badge': FileBadge,
  'file-symlink': FileSymlink,
  app: AppWindow,
  package: Package,
  container: Container,
  git: GitBranch,
  readme: BookOpenText,
  agents: Bot,
  folder: Folder,
  'folder-open': FolderOpen,
  'folder-code': FolderCode,
  'folder-tests': FolderCheck,
  'folder-modules': FolderArchive,
  'folder-git': FolderGit2,
  'folder-config': FolderCog,
  'folder-docs': FolderBookmark,
  'folder-output': FolderOutput,
  'folder-symlink': FolderSymlink,
};

interface Props {
  name: string;
  dir: boolean;
  open?: boolean;
  link?: boolean;
}

/** A file's or folder's icon in the explorer: by type, with the tone of its category. */
export function FileIcon({ name, dir, open = false, link = false }: Props) {
  const spec = dir ? folderIcon(name, open, link) : fileIcon(name, link);
  const Icon = ICONS[spec.icon];
  return <Icon className="file-icon" data-icon={spec.icon} data-tone={spec.tone} aria-hidden="true" />;
}
