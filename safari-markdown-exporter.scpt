-- Safari Markdown Exporter
-- Extracts page content as markdown and saves to Obsidian
-- Supports both web pages and PDFs
-- Keyboard shortcut: Set up via Automator Quick Action

-- Configuration - paths to Python environment
property pythonScript : "/Users/varunr/projects/tools/safari-markdown-exporter.py"
property pythonPath : "/Users/varunr/projects/tools/venv311/bin/python3"
property tempHtmlFile : "/tmp/safari-markdown-export.html"
property tempPdfFile : "/tmp/safari-markdown-export.pdf"

-- Helper: Check if URL points to a PDF (handles query strings)
on isPdfURL(theURL)
	-- Remove query string and fragment for extension check
	set urlPath to theURL
	if urlPath contains "?" then
		set urlPath to text 1 thru ((offset of "?" in urlPath) - 1) of urlPath
	end if
	if urlPath contains "#" then
		set urlPath to text 1 thru ((offset of "#" in urlPath) - 1) of urlPath
	end if
	return (urlPath ends with ".pdf") or (urlPath ends with ".PDF")
end isPdfURL

-- Helper: Write text to file using native AppleScript I/O
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

-- Helper: Clean up temp files
on cleanupTempFile(filePath)
	try
		do shell script "rm -f " & quoted form of filePath
	end try
end cleanupTempFile

-- Helper: Exit Reader Mode if it was toggled
on exitReaderMode(wasToggled)
	if wasToggled then
		tell application "System Events"
			tell process "Safari"
				try
					click menu item "Hide Reader" of menu "View" of menu bar 1
				end try
			end tell
		end tell
	end if
end exitReaderMode

-- Main script
on run
	tell application "Safari"
		activate

		-- Get URL and title from current tab
		set pageURL to URL of current tab of front window
		set pageTitle to name of current tab of front window
	end tell

	-- Check if this is a PDF
	if my isPdfURL(pageURL) then
		-- Handle PDF: download the file directly
		try
			-- Use 30-second timeout for download
			do shell script "curl -L -s --max-time 30 -o " & quoted form of tempPdfFile & " " & quoted form of pageURL
		on error errMsg
			display notification "Failed to download PDF: " & errMsg with title "Export Failed" sound name "Basso"
			return
		end try

		-- Call Python script with --pdf flag
		try
			set exportResult to do shell script pythonPath & " " & quoted form of pythonScript & " " & quoted form of tempPdfFile & " " & quoted form of pageURL & " " & quoted form of pageTitle & " --pdf"
			set savedFilename to exportResult
		on error errMsg
			display notification "Python error: " & errMsg with title "Export Failed" sound name "Basso"
			my cleanupTempFile(tempPdfFile)
			return
		end try

		-- Clean up temp file
		my cleanupTempFile(tempPdfFile)

		-- Show success notification
		display notification "Saved PDF: " & savedFilename with title "Markdown Exported" sound name "Pop"

	else
		-- Handle web page: use Reader Mode and extract HTML
		set readerWasToggled to false
		tell application "System Events"
			tell process "Safari"
				-- Check if Reader Mode menu item exists and is available
				try
					set readerMenuItem to menu item "Show Reader" of menu "View" of menu bar 1
					if enabled of readerMenuItem then
						click readerMenuItem
						set readerWasToggled to true
						delay 0.8 -- Wait for Reader Mode to render
					end if
				on error
					-- Reader not available for this page, continue anyway
				end try
			end tell
		end tell

		-- Extract full HTML from page
		tell application "Safari"
			tell current tab of front window
				set pageHTML to do JavaScript "document.documentElement.outerHTML"
			end tell
		end tell

		-- Write HTML to temp file using native AppleScript file I/O
		try
			my writeTextToFile(pageHTML, tempHtmlFile)
		on error errMsg
			display notification "Failed to write temp file: " & errMsg with title "Export Failed" sound name "Basso"
			my exitReaderMode(readerWasToggled)
			return
		end try

		-- Call Python script
		try
			set exportResult to do shell script pythonPath & " " & quoted form of pythonScript & " " & quoted form of tempHtmlFile & " " & quoted form of pageURL & " " & quoted form of pageTitle
			set savedFilename to exportResult
		on error errMsg
			display notification "Python error: " & errMsg with title "Export Failed" sound name "Basso"
			my cleanupTempFile(tempHtmlFile)
			my exitReaderMode(readerWasToggled)
			return
		end try

		-- Clean up temp file
		my cleanupTempFile(tempHtmlFile)

		-- Exit Reader Mode if we toggled it
		my exitReaderMode(readerWasToggled)

		-- Scroll to bottom of page (visual indicator of completion)
		tell application "Safari"
			tell current tab of front window
				do JavaScript "window.scrollTo(0, document.body.scrollHeight);"
			end tell
		end tell

		-- Show success notification
		display notification "Saved: " & savedFilename with title "Markdown Exported" sound name "Pop"
	end if
end run
