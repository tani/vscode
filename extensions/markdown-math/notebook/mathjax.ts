/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type * as markdownIt from 'markdown-it';
import type { RendererContext } from 'vscode-notebook-renderer';

export async function activate(ctx: RendererContext<void>) {
	const markdownItRenderer = (await ctx.getRenderer('markdownItRenderer')) as undefined | any;
	if (!markdownItRenderer) {
		throw new Error('Could not load markdownItRenderer');
	}

	const mathjax = require('markdown-it-mathjax3');
	markdownItRenderer.extendMarkdownIt((md: markdownIt.MarkdownIt) => {
		return md.use(mathjax, {
			globalGroup: true,
			enableBareBlocks: true,
		});
	});
}
