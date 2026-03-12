/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as debounce from 'debounce';
import React, { useContext, useEffect, useState } from 'react';
import { render } from 'react-dom';
import { Overview } from './overview';
import { PullRequest } from '../../src/github/views';
import { COMMENT_TEXTAREA_ID } from '../common/constants';
import PullRequestContext from '../common/context';

const LOCALIZED_MARKER = 'data-link-localized';

interface LocalizableAnchor {
	element: HTMLAnchorElement;
	url: string;
	file: string;
	startLine: number;
	endLine: number;
	type: 'blob' | 'diff';
	diffHash?: string;
}

function findUnlocalizedAnchors(
	root: Document | Element,
	repoName: string,
	prNumber?: number,
): LocalizableAnchor[] {
	const anchors: LocalizableAnchor[] = [];
	const urlPattern = new RegExp(
		`^https://github\\.com/[^/]+/${repoName}/blob/[0-9a-f]{40}/([^#]+)#L([0-9]+)(?:-L([0-9]+))?$`,
	);
	const diffUrlPattern = prNumber !== undefined && new RegExp(
		`^https://github\\.com/[^/]+/${repoName}/pull/${prNumber}/(?:files|changes)#diff-([a-f0-9]{64})(?:R(\\d+)(?:-R(\\d+))?)?$`,
	);

	// Find all unlocalized anchor elements
	const allAnchors = root.querySelectorAll(
		`a[href^="https://github.com/"]:not([${LOCALIZED_MARKER}])`,
	);

	allAnchors.forEach((anchor: Element) => {
		const htmlAnchor = anchor as HTMLAnchorElement;

		const href = htmlAnchor.getAttribute('href');
		if (!href) return;

		// Try blob permalink pattern first
		const blobMatch = href.match(urlPattern);
		if (blobMatch) {
			const file = blobMatch[1];
			const startLine = parseInt(blobMatch[2]);
			const endLine = blobMatch[3] ? parseInt(blobMatch[3]) : startLine;

			anchors.push({
				element: htmlAnchor,
				url: href,
				file,
				startLine,
				endLine,
				type: 'blob',
			});
			return;
		}

		// Try diff link pattern (only if we have a PR number)
		const diffMatch = diffUrlPattern && href.match(diffUrlPattern);
		if (diffMatch) {
			const diffHash = diffMatch[1];
			const startLine = diffMatch[2] ? parseInt(diffMatch[2]) : 1;
			const endLine = diffMatch[3] ? parseInt(diffMatch[3]) : startLine;

			anchors.push({
				element: htmlAnchor,
				url: href,
				file: '', // Will be resolved later via hash mapping
				startLine,
				endLine,
				type: 'diff',
				diffHash,
			});
		}
	});

	return anchors;
}


function localizeAnchors(
	anchors: LocalizableAnchor[],
	fileExistenceMap: Record<string, boolean>,
	hashMap?: Record<string, string>,
): void {
	anchors.forEach(({ element, url, file, startLine, endLine, type, diffHash }) => {
		let resolvedFile = file;

		// For diff links, resolve the file path from the hash
		if (type === 'diff' && diffHash && hashMap) {
			const hashKey = `diff-${diffHash}`;
			resolvedFile = hashMap[hashKey];
			if (!resolvedFile) {
				// Hash not found in mapping - file may not exist in this PR
				return;
			}
		}

		// For blob permalinks, check file existence
		if (type === 'blob') {
			const exists = fileExistenceMap[resolvedFile];
			if (!exists) {
				return;
			}
		}

		// Set data attributes for the click handler
		element.setAttribute('data-local-file', resolvedFile);
		element.setAttribute('data-start-line', startLine.toString());
		element.setAttribute('data-end-line', endLine.toString());
		element.setAttribute('data-link-type', type);

		// Add "(view on GitHub)" link after this anchor
		const githubLink = document.createElement('a');
		githubLink.href = url;
		githubLink.textContent = 'view on GitHub';
		githubLink.setAttribute(LOCALIZED_MARKER, 'true');
		if (element.className) {
			githubLink.className = element.className;
		}
		element.after(
			document.createTextNode(' ('),
			githubLink,
			document.createTextNode(')'),
		);
	});
}

export function main() {
	render(<Root>{pr => <Overview {...pr} />}</Root>, document.getElementById('app'));
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<PullRequest | undefined>(ctx.pr);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.pr);
	}, []);

	// Restore focus to comment textarea when window regains focus if user was typing
	useEffect(() => {
		const handleWindowFocus = () => {
			// Delay to let the focus event settle before checking focus state
			const FOCUS_SETTLE_DELAY_MS = 100;
			setTimeout(() => {
				const commentTextarea = document.getElementById(COMMENT_TEXTAREA_ID) as HTMLTextAreaElement;
				// Only restore focus if there's content and nothing else has focus
				if (commentTextarea && commentTextarea.value && document.activeElement === document.body) {
					commentTextarea.focus();
				}
			}, FOCUS_SETTLE_DELAY_MS);
		};

		window.addEventListener('focus', handleWindowFocus);
		return () => window.removeEventListener('focus', handleWindowFocus);
	}, []);

	useEffect(() => {
		const handleLinkClick = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			const anchor = target.closest('a[data-local-file]');
			if (anchor) {
				const file = anchor.getAttribute('data-local-file');
				const startLine = anchor.getAttribute('data-start-line');
				const endLine = anchor.getAttribute('data-end-line');
				const linkType = anchor.getAttribute('data-link-type');
				if (file && startLine && endLine) {
					// Swallow the event
					event.preventDefault();
					event.stopPropagation();

					// Open diff view for diff links, local file for blob permalinks
					if (linkType === 'diff') {
						ctx.openDiffFromLink(file, parseInt(startLine), parseInt(endLine));
					} else {
						ctx.openLocalFile(file, parseInt(startLine), parseInt(endLine));
					}
				}
			}
		};

		document.addEventListener('click', handleLinkClick, true);
		return () => document.removeEventListener('click', handleLinkClick, true);
	}, [ctx]);

	// Process GitHub links
	useEffect(() => {
		if (!pr) return;

		const processAnchors = debounce(async () => {
			try {
				const anchors = findUnlocalizedAnchors(document.body, pr.repo, pr.number);
				anchors.forEach(({ element }) => {
					element.setAttribute(LOCALIZED_MARKER, 'true');
				});

				if (anchors.length > 0) {
					// Separate blob and diff anchors
					const blobAnchors = anchors.filter((a) => a.type === 'blob');
					const diffAnchors = anchors.filter((a) => a.type === 'diff');

					// Localize blob permalinks
					if (blobAnchors.length > 0) {
						const uniqueFiles = Array.from(new Set(blobAnchors.map((a) => a.file)));
						const fileExistenceMap = await ctx.checkFilesExist(uniqueFiles);
						localizeAnchors(blobAnchors, fileExistenceMap);
					}

					// Localize diff links
					if (diffAnchors.length > 0) {
						const hashMap = await ctx.getFilePathHashMap();
						localizeAnchors(diffAnchors, {}, hashMap);
					}
				}
			} catch (error) {
				console.error('Error processing links:', error);
			}
		}, 100);

		// Start observing the document body for changes
		const observer = new MutationObserver((mutations) => {
			const hasNewNodes = mutations.some(
				({ addedNodes }) => addedNodes.length > 0,
			);

			if (hasNewNodes) {
				processAnchors();
			}
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});

		// Process the initial set of links
		processAnchors();

		return () => {
			observer.disconnect();
			processAnchors.clear();
		};
	}, [pr, ctx]);

	window.onscroll = debounce(() => {
		ctx.postMessage({
			command: 'scroll',
			args: {
				scrollPosition: {
					x: window.scrollX,
					y: window.scrollY
				}
			}
		});
	}, 200);
	ctx.postMessage({ command: 'ready' });
	ctx.postMessage({ command: 'pr.debug', args: 'initialized ' + (pr ? 'with PR' : 'without PR') });
	return pr ? children(pr) : <div className="loading-indicator">Loading...</div>;
}
