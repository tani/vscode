/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OperatingSystem } from 'vs/base/common/platform';
import { withUndefinedAsNull } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ITerminalLinkDetector, ITerminalSimpleLink, TerminalLinkType } from 'vs/workbench/contrib/terminal/browser/links/links';
import { convertLinkRangeToBuffer, getXtermLineContent } from 'vs/workbench/contrib/terminal/browser/links/terminalLinkHelpers';
import { IBufferLine, Terminal } from 'xterm';

const enum Constants {
	/**
	 * The max line length to try extract word links from.
	 */
	MaxLineLength = 2000
}

const pathPrefix = '(\\.\\.?|\\~)';
const pathSeparatorClause = '\\/';
// '":; are allowed in paths but they are often separators so ignore them
// Also disallow \\ to prevent a catastropic backtracking case #24795
const excludedPathCharactersClause = '[^\\0\\s!`&*()\\[\\]\'":;\\\\]';
/** A regex that matches paths in the form /foo, ~/foo, ./foo, ../foo, foo/bar */
export const unixLocalLinkClause = '((' + pathPrefix + '|(' + excludedPathCharactersClause + ')+)?(' + pathSeparatorClause + '(' + excludedPathCharactersClause + ')+)+)';

export const winDrivePrefix = '(?:\\\\\\\\\\?\\\\)?[a-zA-Z]:';
const winPathPrefix = '(' + winDrivePrefix + '|\\.\\.?|\\~)';
const winPathSeparatorClause = '(\\\\|\\/)';
const winExcludedPathCharactersClause = '[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]\'":;]';
/** A regex that matches paths in the form \\?\c:\foo c:\foo, ~\foo, .\foo, ..\foo, foo\bar */
export const winLocalLinkClause = '((' + winPathPrefix + '|(' + winExcludedPathCharactersClause + ')+)?(' + winPathSeparatorClause + '(' + winExcludedPathCharactersClause + ')+)+)';

/** As xterm reads from DOM, space in that case is nonbreaking char ASCII code - 160,
replacing space with nonBreakningSpace or space ASCII code - 32. */
export const lineAndColumnClause = [
	'((\\S*)[\'"], line ((\\d+)( column (\\d+))?))', // "(file path)", line 45 [see #40468]
	'((\\S*)[\'"],((\\d+)(:(\\d+))?))', // "(file path)",45 [see #78205]
	'((\\S*) on line ((\\d+)(, column (\\d+))?))', // (file path) on line 8, column 13
	'((\\S*):line ((\\d+)(, column (\\d+))?))', // (file path):line 8, column 13
	'(([^\\s\\(\\)]*)(\\s?[\\(\\[](\\d+)(,\\s?(\\d+))?)[\\)\\]])', // (file path)(45), (file path) (45), (file path)(45,18), (file path) (45,18), (file path)(45, 18), (file path) (45, 18), also with []
	'(([^:\\s\\(\\)<>\'\"\\[\\]]*)(:(\\d+))?(:(\\d+))?)' // (file path):336, (file path):336:9
].join('|').replace(/ /g, `[${'\u00A0'} ]`);

// Changing any regex may effect this value, hence changes this as well if required.
export const winLineAndColumnMatchIndex = 12;
export const unixLineAndColumnMatchIndex = 11;

// Each line and column clause have 6 groups (ie no. of expressions in round brackets)
export const lineAndColumnClauseGroupCount = 6;

const cachedValidatedLinks = new Map<string, { uri: URI, link: string, isDirectory: boolean } | null>();

export class TerminalLocalLinkDetector implements ITerminalLinkDetector {
	static id = 'local';

	private _cacheTilTimeout = 0;
	protected _enableCaching = true;

	constructor(
		readonly xterm: Terminal,
		private readonly _os: OperatingSystem,
		private readonly _resolvePath: (link: string) => Promise<{ uri: URI, link: string, isDirectory: boolean } | undefined>,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService
	) {
	}

	async detect(lines: IBufferLine[], startLine: number, endLine: number): Promise<ITerminalSimpleLink[]> {
		const links: ITerminalSimpleLink[] = [];

		// Reset cached link TTL
		if (this._enableCaching) {
			if (this._cacheTilTimeout) {
				window.clearTimeout(this._cacheTilTimeout);
			}
			this._cacheTilTimeout = window.setTimeout(() => cachedValidatedLinks.clear(), 10000);
		}

		// Get the text representation of the wrapped line
		const text = getXtermLineContent(this.xterm.buffer.active, startLine, endLine, this.xterm.cols);
		if (text === '' || text.length > Constants.MaxLineLength) {
			return [];
		}

		// clone regex to do a global search on text
		const rex = new RegExp(this._localLinkRegex, 'g');
		let match;
		let stringIndex = -1;
		while ((match = rex.exec(text)) !== null) {
			// const link = match[typeof matcher.matchIndex !== 'number' ? 0 : matcher.matchIndex];
			let link = match[0];
			if (!link) {
				// something matched but does not comply with the given matchIndex
				// since this is most likely a bug the regex itself we simply do nothing here
				// this._logService.debug('match found without corresponding matchIndex', match, matcher);
				break;
			}

			// Get index, match.index is for the outer match which includes negated chars
			// therefore we cannot use match.index directly, instead we search the position
			// of the match group in text again
			// also correct regex and string search offsets for the next loop run
			stringIndex = text.indexOf(link, stringIndex + 1);
			rex.lastIndex = stringIndex + link.length;
			if (stringIndex < 0) {
				// invalid stringIndex (should not have happened)
				break;
			}

			// Adjust the link range to exclude a/ and b/ if it looks like a git diff
			if (
				// --- a/foo/bar
				// +++ b/foo/bar
				((text.startsWith('--- a/') || text.startsWith('+++ b/')) && stringIndex === 4) ||
				// diff --git a/foo/bar b/foo/bar
				(text.startsWith('diff --git') && (link.startsWith('a/') || link.startsWith('b/')))
			) {
				link = link.substring(2);
				stringIndex += 2;
			}

			// Convert the link text's string index into a wrapped buffer range
			const bufferRange = convertLinkRangeToBuffer(lines, this.xterm.cols, {
				startColumn: stringIndex + 1,
				startLineNumber: 1,
				endColumn: stringIndex + link.length + 1,
				endLineNumber: 1
			}, startLine);

			console.log('eval', link);
			let linkStat = cachedValidatedLinks.get(link);

			// The link is cached as doesn't exist
			if (linkStat === null) {
				continue;
			}

			// The link isn't cached
			if (linkStat === undefined) {
				const linkCandidates = [link];
				if (link.match(/^(\.\.[\/\\])+/)) {
					linkCandidates.push(link.replace(/^(\.\.[\/\\])+/, ''));
				}
				const linkStat = await this._validateLinkCandidates(linkCandidates);
				if (this._enableCaching) {
					cachedValidatedLinks.set(link, withUndefinedAsNull(linkStat));
				}
			}


			// Create the link if validated
			if (linkStat) {
				let type: TerminalLinkType;
				if (linkStat.isDirectory) {
					if (this._isDirectoryInsideWorkspace(linkStat.uri)) {
						type = TerminalLinkType.LocalFolderInWorkspace;
					} else {
						type = TerminalLinkType.LocalFolderOutsideWorkspace;
					}
				} else {
					type = TerminalLinkType.LocalFile;
				}
				// const label = linkStat.isDirectory
				// 	? (this._isDirectoryInsideWorkspace(linkStat.uri) ? FOLDER_IN_WORKSPACE_LABEL : FOLDER_NOT_IN_WORKSPACE_LABEL)
				// 	: OPEN_FILE_LABEL;
				// const activateCallback = this._wrapLinkHandler((event: MouseEvent | undefined, text: string) => {
				// 	if (linkStat!.isDirectory) {
				// 		this._handleLocalFolderLink(linkStat!.uri);
				// 	} else {
				// 		this._activateFileCallback(event, text);
				// 	}
				// });
				links.push({
					text: linkStat.link,
					uri: linkStat.uri,
					bufferRange,
					type
				});
				// const validatedLink = this._instantiationService.createInstance(TerminalLink, this._xterm, bufferRange, linkStat.link, this._xterm.buffer.active.viewportY, activateCallback, this._tooltipCallback, true, label);
				// links.push(validatedLink);
			}
		}

		console.log('local link detector', links);
		return links;
	}

	protected get _localLinkRegex(): RegExp {
		const baseLocalLinkClause = this._os === OperatingSystem.Windows ? winLocalLinkClause : unixLocalLinkClause;
		// Append line and column number regex
		return new RegExp(`${baseLocalLinkClause}(${lineAndColumnClause})`);
	}

	private _isDirectoryInsideWorkspace(uri: URI) {
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (let i = 0; i < folders.length; i++) {
			if (this._uriIdentityService.extUri.isEqualOrParent(uri, folders[i].uri)) {
				return true;
			}
		}
		return false;
	}

	private async _validateLinkCandidates(linkCandidates: string[]): Promise<{ uri: URI, link: string, isDirectory: boolean } | undefined> {
		for (const link of linkCandidates) {
			const result = await this._resolvePath(link);
			if (result) {
				return result;
			}
		}
		return undefined;
	}
}