-- Safari Markdown Exporter (JavaScript Version)
-- Extracts page content as markdown and saves to Obsidian
-- Zero external dependencies - uses embedded JavaScript for HTML-to-Markdown conversion
-- Downloads images locally and converts to Obsidian wiki-links
-- Keyboard shortcut: Set up via Automator Quick Action

-- Configuration
property obsidianBase : "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Varun/Saved Pages"

-- Expand tilde in path
on expandPath(thePath)
	if thePath starts with "~" then
		set homePath to POSIX path of (path to home folder)
		if homePath ends with "/" then set homePath to text 1 thru -2 of homePath
		return homePath & text 2 thru -1 of thePath
	end if
	return thePath
end expandPath

-- Get domain from URL, stripping www. prefix
on getDomain(theURL)
	set oldDelims to AppleScript's text item delimiters
	try
		-- Extract host from URL
		set AppleScript's text item delimiters to "//"
		set urlParts to text items of theURL
		if (count of urlParts) > 1 then
			set hostPart to item 2 of urlParts
		else
			set hostPart to theURL
		end if

		-- Remove path
		set AppleScript's text item delimiters to "/"
		set theDomain to text item 1 of hostPart

		-- Remove port if present
		set AppleScript's text item delimiters to ":"
		set theDomain to text item 1 of theDomain

		-- Strip www.
		if theDomain starts with "www." then
			set theDomain to text 5 thru -1 of theDomain
		end if

		set AppleScript's text item delimiters to oldDelims
		return theDomain
	on error
		set AppleScript's text item delimiters to oldDelims
		return "unknown"
	end try
end getDomain

-- Sanitize filename
on sanitizeFilename(theTitle)
	set badChars to {":", "/", "\\", "*", "?", "\"", "<", ">", "|"}
	set cleanTitle to theTitle
	repeat with badChar in badChars
		set oldDelims to AppleScript's text item delimiters
		set AppleScript's text item delimiters to badChar
		set titleParts to text items of cleanTitle
		set AppleScript's text item delimiters to "-"
		set cleanTitle to titleParts as text
		set AppleScript's text item delimiters to oldDelims
	end repeat

	-- Collapse multiple spaces/dashes and trim
	set cleanTitle to do shell script "echo " & quoted form of cleanTitle & " | sed 's/[[:space:]-]\\{2,\\}/ /g' | sed 's/^[[:space:]-]*//' | sed 's/[[:space:]-]*$//'"

	-- Truncate if too long
	if length of cleanTitle > 80 then
		set cleanTitle to text 1 thru 80 of cleanTitle
	end if

	return cleanTitle
end sanitizeFilename

-- Get next counter for domain folder
on getNextCounter(folderPath)
	set counterFile to folderPath & "/.counter"
	try
		set counterValue to do shell script "cat " & quoted form of counterFile & " 2>/dev/null || echo 0"
		return (counterValue as integer) + 1
	on error
		-- Count existing .md files as fallback
		try
			set fileCount to do shell script "ls -1 " & quoted form of folderPath & "/*.md 2>/dev/null | wc -l | tr -d ' '"
			return (fileCount as integer) + 1
		on error
			return 1
		end try
	end try
end getNextCounter

-- Save counter value
on saveCounter(folderPath, counterValue)
	set counterFile to folderPath & "/.counter"
	do shell script "echo " & counterValue & " > " & quoted form of counterFile
end saveCounter

-- Write text to file using native AppleScript I/O
on writeTextToFile(theText, filePath)
	set fileRef to open for access POSIX file filePath with write permission
	try
		set eof of fileRef to 0
		write theText to fileRef as «class utf8»
		close access fileRef
		return true
	on error errMsg
		try
			close access POSIX file filePath
		end try
		error errMsg
	end try
end writeTextToFile

-- Create YAML frontmatter
on createFrontmatter(theTitle, theURL, theDomain)
	set today to do shell script "date +%Y-%m-%d"
	set safeTitle to my replaceText(theTitle, "\"", "\\\"")
	return "---
title: \"" & safeTitle & "\"
url: " & theURL & "
domain: " & theDomain & "
date_saved: " & today & "
---

"
end createFrontmatter

-- Helper: Replace text
on replaceText(theText, searchStr, replaceStr)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to searchStr
	set textParts to text items of theText
	set AppleScript's text item delimiters to replaceStr
	set newText to textParts as text
	set AppleScript's text item delimiters to oldDelims
	return newText
end replaceText

-- Extract filename from URL
on getFilenameFromURL(imageURL)
	-- Remove query string and fragment
	set cleanURL to imageURL
	if cleanURL contains "?" then
		set cleanURL to text 1 thru ((offset of "?" in cleanURL) - 1) of cleanURL
	end if
	if cleanURL contains "#" then
		set cleanURL to text 1 thru ((offset of "#" in cleanURL) - 1) of cleanURL
	end if

	-- Get last path component
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to "/"
	set pathParts to text items of cleanURL
	set AppleScript's text item delimiters to oldDelims

	if (count of pathParts) > 0 then
		set fileName to last item of pathParts
		-- URL decode the filename using printf (no Python needed)
		try
			set fileName to do shell script "printf '%b' \"$(echo " & quoted form of fileName & " | sed 's/+/ /g; s/%\\([0-9A-Fa-f][0-9A-Fa-f]\\)/\\\\x\\1/g')\""
		end try
		-- If no extension or invalid, generate one
		if fileName does not contain "." or length of fileName < 3 then
			set fileName to "image_" & (random number from 1000 to 9999) & ".jpg"
		end if
		return fileName
	end if

	return "image_" & (random number from 1000 to 9999) & ".jpg"
end getFilenameFromURL

-- Download image and return local filename (or empty string on failure)
on downloadImage(imageURL, assetFolder, pageURL)
	-- Skip data URIs, SVGs, tracking pixels
	if imageURL starts with "data:" then return ""
	if imageURL contains "1x1" then return ""
	if imageURL contains "pixel" then return ""
	if imageURL contains "track" then return ""
	if imageURL contains "beacon" then return ""
	if imageURL ends with ".svg" then return ""

	-- Resolve relative URLs
	set fullURL to imageURL
	if imageURL does not start with "http://" and imageURL does not start with "https://" then
		-- Build absolute URL from page URL
		if imageURL starts with "//" then
			set fullURL to "https:" & imageURL
		else if imageURL starts with "/" then
			-- Get origin from page URL
			try
				set origin to do shell script "echo " & quoted form of pageURL & " | sed 's|^\\(https\\{0,1\\}://[^/]*\\).*|\\1|'"
				set fullURL to origin & imageURL
			on error
				return ""
			end try
		else
			-- Relative path - get base URL
			try
				set baseURL to do shell script "echo " & quoted form of pageURL & " | sed 's|/[^/]*$|/|'"
				set fullURL to baseURL & imageURL
			on error
				return ""
			end try
		end if
	end if

	-- Get filename
	set fileName to my getFilenameFromURL(fullURL)

	-- Check if file already exists, add counter if so
	set targetPath to assetFolder & "/" & fileName
	set fileExists to false
	try
		do shell script "test -f " & quoted form of targetPath
		set fileExists to true
	end try

	if fileExists then
		-- Add counter to filename
		set oldDelims to AppleScript's text item delimiters
		set AppleScript's text item delimiters to "."
		set nameParts to text items of fileName
		set AppleScript's text item delimiters to oldDelims

		if (count of nameParts) > 1 then
			set baseName to items 1 thru -2 of nameParts as text
			set ext to last item of nameParts
			set counter to 2
			repeat while fileExists
				set fileName to baseName & "-" & counter & "." & ext
				set targetPath to assetFolder & "/" & fileName
				try
					do shell script "test -f " & quoted form of targetPath
					set counter to counter + 1
				on error
					set fileExists to false
				end try
			end repeat
		end if
	end if

	-- Download with curl
	try
		do shell script "curl -L -s --max-time 15 -A 'Mozilla/5.0 Safari/537.36' -o " & quoted form of targetPath & " " & quoted form of fullURL
		-- Verify file was created and has content
		set fileSize to do shell script "stat -f%z " & quoted form of targetPath & " 2>/dev/null || echo 0"
		if (fileSize as integer) < 100 then
			-- Too small, probably an error
			do shell script "rm -f " & quoted form of targetPath
			return ""
		end if
		return fileName
	on error
		return ""
	end try
end downloadImage

-- Extract image references from markdown and return as list
on extractImageURLs(markdownText)
	-- Use grep to find all markdown image patterns ![...](...)
	try
		set imageURLs to do shell script "echo " & quoted form of markdownText & " | grep -oE '!\\[[^]]*\\]\\([^)]+\\)' | sed 's/!\\[[^]]*\\](\\([^)]*\\))/\\1/' || true"
		if imageURLs is "" then return {}

		set oldDelims to AppleScript's text item delimiters
		set AppleScript's text item delimiters to linefeed
		set urlList to text items of imageURLs
		set AppleScript's text item delimiters to oldDelims

		return urlList
	on error
		return {}
	end try
end extractImageURLs

-- Process images: download and rewrite markdown
on processImages(markdownText, assetFolder, folderName, pageURL)
	set imageURLs to my extractImageURLs(markdownText)

	if (count of imageURLs) is 0 then
		return markdownText
	end if

	-- Create asset folder
	do shell script "mkdir -p " & quoted form of assetFolder

	set processedMarkdown to markdownText
	set downloadedAny to false

	repeat with imageURL in imageURLs
		set imageURL to imageURL as text
		if imageURL is not "" then
			set localFilename to my downloadImage(imageURL, assetFolder, pageURL)

			if localFilename is not "" then
				set downloadedAny to true
				-- Replace markdown image with Obsidian wiki-link
				-- Find the full markdown image syntax for this URL
				set oldPattern to "![" -- We'll do a simpler replacement
				-- Replace ![anything](imageURL) with ![[folderName/localFilename]]
				set processedMarkdown to do shell script "echo " & quoted form of processedMarkdown & " | sed 's|!\\[[^]]*\\](" & my escapeForSed(imageURL) & ")|![[" & folderName & "/" & localFilename & "]]|g'"
			end if
		end if
	end repeat

	-- Clean up empty asset folder if no images downloaded
	if not downloadedAny then
		try
			do shell script "rmdir " & quoted form of assetFolder & " 2>/dev/null"
		end try
	end if

	return processedMarkdown
end processImages

-- Escape special characters for sed
on escapeForSed(theText)
	-- Escape sed special chars: \ / & [ ] . * ^ $
	set escaped to theText
	set escaped to my replaceText(escaped, "\\", "\\\\")
	set escaped to my replaceText(escaped, "/", "\\/")
	set escaped to my replaceText(escaped, "&", "\\&")
	set escaped to my replaceText(escaped, "[", "\\[")
	set escaped to my replaceText(escaped, "]", "\\]")
	set escaped to my replaceText(escaped, ".", "\\.")
	set escaped to my replaceText(escaped, "*", "\\*")
	set escaped to my replaceText(escaped, "^", "\\^")
	set escaped to my replaceText(escaped, "$", "\\$")
	return escaped
end escapeForSed

-- JavaScript HTML-to-Markdown converter (embedded)
on getMarkdownConverterJS()
	return "
(function() {
    // Lightweight HTML to Markdown converter for clean Reader Mode content
    function htmlToMarkdown(element) {
        let md = '';

        function processNode(node, listDepth = 0) {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return '';

            const tag = node.tagName.toLowerCase();
            const children = Array.from(node.childNodes);
            let content = children.map(c => processNode(c, listDepth)).join('');

            // Skip empty content for block elements
            const trimmed = content.trim();

            switch(tag) {
                // Headers
                case 'h1': return '\\n# ' + trimmed + '\\n\\n';
                case 'h2': return '\\n## ' + trimmed + '\\n\\n';
                case 'h3': return '\\n### ' + trimmed + '\\n\\n';
                case 'h4': return '\\n#### ' + trimmed + '\\n\\n';
                case 'h5': return '\\n##### ' + trimmed + '\\n\\n';
                case 'h6': return '\\n###### ' + trimmed + '\\n\\n';

                // Paragraphs and divs
                case 'p': return trimmed ? '\\n' + trimmed + '\\n\\n' : '';
                case 'div': return trimmed ? '\\n' + content + '\\n' : '';
                case 'article': return content;
                case 'section': return content;
                case 'main': return content;

                // Text formatting
                case 'strong':
                case 'b': return trimmed ? '**' + trimmed + '**' : '';
                case 'em':
                case 'i': return trimmed ? '*' + trimmed + '*' : '';
                case 'code': return trimmed ? '`' + trimmed + '`' : '';
                case 'del':
                case 's': return trimmed ? '~~' + trimmed + '~~' : '';
                case 'mark': return trimmed ? '==' + trimmed + '==' : '';

                // Links
                case 'a':
                    const href = node.getAttribute('href') || '';
                    if (!trimmed) return '';
                    if (href && !href.startsWith('javascript:')) {
                        return '[' + trimmed + '](' + href + ')';
                    }
                    return trimmed;

                // Images
                case 'img':
                    const src = node.getAttribute('src') || '';
                    const alt = node.getAttribute('alt') || '';
                    if (src) return '\\n![' + alt + '](' + src + ')\\n';
                    return '';

                // Lists
                case 'ul':
                case 'ol':
                    return '\\n' + content + '\\n';
                case 'li':
                    const parent = node.parentElement;
                    const isOrdered = parent && parent.tagName.toLowerCase() === 'ol';
                    const indent = '  '.repeat(listDepth);
                    const bullet = isOrdered ? '1. ' : '- ';
                    const liContent = children.map(c => {
                        if (c.nodeType === Node.ELEMENT_NODE &&
                            (c.tagName.toLowerCase() === 'ul' || c.tagName.toLowerCase() === 'ol')) {
                            return processNode(c, listDepth + 1);
                        }
                        return processNode(c, listDepth);
                    }).join('').trim();
                    return indent + bullet + liContent + '\\n';

                // Blockquote
                case 'blockquote':
                    const lines = trimmed.split('\\n').map(l => '> ' + l).join('\\n');
                    return '\\n' + lines + '\\n\\n';

                // Code blocks
                case 'pre':
                    const codeEl = node.querySelector('code');
                    const codeContent = codeEl ? codeEl.textContent : node.textContent;
                    const lang = codeEl ? (codeEl.className.match(/language-(\\w+)/) || [])[1] || '' : '';
                    return '\\n```' + lang + '\\n' + codeContent.trim() + '\\n```\\n\\n';

                // Line breaks
                case 'br': return '\\n';
                case 'hr': return '\\n---\\n\\n';

                // Tables (basic support)
                case 'table': return '\\n' + content + '\\n';
                case 'thead': return content;
                case 'tbody': return content;
                case 'tr':
                    const cells = Array.from(node.children).map(c => processNode(c, listDepth).trim());
                    const row = '| ' + cells.join(' | ') + ' |\\n';
                    // Add header separator after first row in thead
                    if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'thead') {
                        return row + '| ' + cells.map(() => '---').join(' | ') + ' |\\n';
                    }
                    return row;
                case 'th':
                case 'td': return trimmed;

                // Figure and caption
                case 'figure': return content;
                case 'figcaption': return trimmed ? '\\n*' + trimmed + '*\\n\\n' : '';

                // Skip these
                case 'script':
                case 'style':
                case 'nav':
                case 'footer':
                case 'aside':
                case 'noscript':
                    return '';

                // Default: just return content
                default:
                    return content;
            }
        }

        md = processNode(element);

        // Clean up: collapse multiple newlines, trim
        md = md.replace(/\\n{3,}/g, '\\n\\n').trim();

        return md;
    }

    // Try to find the main content
    let content = document.body;

    // Check for Reader Mode content
    const readerContent = document.querySelector('.reader-mode-content, article.reader, [data-reader-content]');
    if (readerContent) {
        content = readerContent;
    } else {
        // Try common article selectors
        const article = document.querySelector('article, [role=\"article\"], .post-content, .article-content, .entry-content, main');
        if (article) {
            content = article;
        }
    }

    return htmlToMarkdown(content);
})();
"
end getMarkdownConverterJS

-- Check if URL points to a PDF
on isPdfURL(theURL)
	set urlLower to do shell script "echo " & quoted form of theURL & " | tr '[:upper:]' '[:lower:]'"
	-- Remove query string for check
	if urlLower contains "?" then
		set urlLower to text 1 thru ((offset of "?" in urlLower) - 1) of urlLower
	end if
	return urlLower ends with ".pdf"
end isPdfURL

-- Main script
on run
	-- Get page info from Safari
	tell application "Safari"
		activate
		set pageURL to URL of current tab of front window
		set pageTitle to name of current tab of front window
	end tell

	-- Check if PDF (not supported in JS version)
	if my isPdfURL(pageURL) then
		display notification "PDF export not supported in JS version. Use the Python version for PDFs." with title "Export Info" sound name "Basso"
		return
	end if

	-- Try to enable Reader Mode for cleaner content
	set readerWasToggled to false
	tell application "System Events"
		tell process "Safari"
			try
				set readerMenuItem to menu item "Show Reader" of menu "View" of menu bar 1
				if enabled of readerMenuItem then
					click readerMenuItem
					set readerWasToggled to true
					delay 0.8
				end if
			on error
				-- Reader not available
			end try
		end tell
	end tell

	-- Convert page to Markdown using embedded JavaScript
	set markdownContent to ""
	tell application "Safari"
		tell current tab of front window
			try
				set markdownContent to do JavaScript my getMarkdownConverterJS()
			on error errMsg
				display notification "JavaScript error: " & errMsg with title "Export Failed" sound name "Basso"
				if readerWasToggled then
					tell application "System Events"
						tell process "Safari"
							try
								click menu item "Hide Reader" of menu "View" of menu bar 1
							end try
						end tell
					end tell
				end if
				return
			end try
		end tell
	end tell

	-- Exit Reader Mode if we toggled it
	if readerWasToggled then
		tell application "System Events"
			tell process "Safari"
				try
					click menu item "Hide Reader" of menu "View" of menu bar 1
				end try
			end tell
		end tell
	end if

	-- Check if we got content
	if markdownContent is "" or markdownContent is missing value then
		display notification "No content extracted from page" with title "Export Failed" sound name "Basso"
		return
	end if

	-- Setup paths
	set basePath to my expandPath(obsidianBase)
	set theDomain to my getDomain(pageURL)
	set domainFolder to basePath & "/" & theDomain

	-- Create domain folder if needed
	do shell script "mkdir -p " & quoted form of domainFolder

	-- Get counter and build filename
	set counter to my getNextCounter(domainFolder)
	set today to do shell script "date +%Y-%m-%d"
	set safeTitle to my sanitizeFilename(pageTitle)
	set paddedCounter to text -3 thru -1 of ("000" & counter)
	set folderName to paddedCounter & " - " & today & " - " & safeTitle
	set filename to folderName & ".md"
	set filePath to domainFolder & "/" & filename
	set assetFolder to domainFolder & "/" & folderName

	-- Process images: download and rewrite markdown links
	set markdownContent to my processImages(markdownContent, assetFolder, folderName, pageURL)

	-- Build full content with frontmatter
	set frontmatter to my createFrontmatter(pageTitle, pageURL, theDomain)
	set fullContent to frontmatter & markdownContent

	-- Write file
	try
		my writeTextToFile(fullContent, filePath)
	on error errMsg
		display notification "Failed to write file: " & errMsg with title "Export Failed" sound name "Basso"
		return
	end try

	-- Save counter
	my saveCounter(domainFolder, counter)

	-- Scroll to bottom (visual indicator of completion)
	tell application "Safari"
		tell current tab of front window
			do JavaScript "window.scrollTo(0, document.body.scrollHeight);"
		end tell
	end tell

	-- Success notification
	display notification "Saved: " & filename with title "Markdown Exported" sound name "Pop"
end run
