// "Install Sovereign.exe": a double-clickable installer with the
// Sovereign icon. It only runs install.bat from its own folder (a .bat
// file can't carry an icon). Rebuild with installer\build.bat.
using System;
using System.Diagnostics;
using System.IO;

class Launcher
{
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string bat = Path.Combine(dir, "install.bat");
        if (!File.Exists(bat))
        {
            Console.WriteLine("install.bat was not found next to this program.");
            Console.WriteLine("Keep \"Install Sovereign.exe\" in the Sovereign folder.");
            Console.WriteLine("Press any key to close.");
            Console.ReadKey();
            return 1;
        }
        Console.Title = "Sovereign installer";
        var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + bat + "\"\"")
        {
            WorkingDirectory = dir,
            UseShellExecute = false,
        };
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
