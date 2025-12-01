-- Safari PDF Exporter with Auto-Scroll
-- Keyboard shortcut: Set up via Automator Quick Action

-- Counter file to persist between runs
property counterFile : (POSIX path of (path to documents folder)) & ".safari-pdf-counter"

-- Get or initialize counter
on getCounter()
	try
		set counterValue to do shell script "cat " & quoted form of counterFile
		return counterValue as integer
	on error
		return 1
	end try
end getCounter

-- Save counter
on saveCounter(num)
	do shell script "echo " & num & " > " & quoted form of counterFile
end saveCounter

-- Main script
tell application "Safari"
	activate
	set pageTitle to name of current tab of front window
	-- Clean the title for filename (remove problematic characters)
	set cleanTitle to do shell script "echo " & quoted form of pageTitle & " | sed 's/[/:*?\"<>|]/-/g' | sed 's/  */ /g'"
end tell

-- Get counter and format with leading zeros
set counter to getCounter()
set paddedCounter to text -3 thru -1 of ("000" & counter)

-- Build filename
set outputFolder to POSIX path of (path to documents folder)
set fileName to paddedCounter & " - " & cleanTitle & ".pdf"
set fullPath to outputFolder & fileName

-- Export PDF using keyboard shortcut
tell application "System Events"
	tell process "Safari"
		-- File > Export as PDF (Cmd+Shift+E on some versions, or use menu)
		click menu item "Export as PDF…" of menu "File" of menu bar 1

		-- Wait for save dialog
		delay 0.5

		-- Type the filename
		keystroke "g" using {command down, shift down} -- Go to folder
		delay 0.3
		keystroke outputFolder
		delay 0.2
		keystroke return
		delay 0.3

		-- Set filename
		keystroke "a" using {command down}
		keystroke fileName
		delay 0.2

		-- Click Save
		keystroke return
	end tell
end tell

-- Wait for save to complete
delay 1.5

-- Scroll to bottom of page
tell application "Safari"
	tell current tab of front window
		do JavaScript "window.scrollTo(0, document.body.scrollHeight);"
	end tell
end tell

-- Increment counter
saveCounter(counter + 1)

-- Brief pause to let scroll complete
delay 0.5

-- Go to next lesson (Ctrl + >)
tell application "System Events"
	tell process "Safari"
		key code 47 using {control down, shift down} -- > is shift+. (key code 47)
	end tell
end tell

-- Optional: Show notification
display notification "Saved: " & fileName & " → Next lesson" with title "PDF Exported" sound name "Pop"
