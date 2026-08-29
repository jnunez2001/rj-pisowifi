namespace StarkFiRentalClient;

// WinForms has no built-in input box (that's VB.Net only) - this is the
// smallest reasonable replacement, used just for the Staff Override
// password prompt.
public static class PromptDialog
{
    public static string? Show(string title, string label, bool isPassword = false)
    {
        using var form = new Form
        {
            Width = 360,
            Height = 160,
            Text = title,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            TopMost = true
        };
        var lbl = new Label { Left = 16, Top = 16, Width = 320, Text = label };
        var input = new TextBox { Left = 16, Top = 44, Width = 320, PasswordChar = isPassword ? '*' : '\0' };
        var ok = new Button { Text = "OK", Left = 176, Top = 80, Width = 80, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "Cancel", Left = 264, Top = 80, Width = 72, DialogResult = DialogResult.Cancel };
        form.Controls.AddRange(new Control[] { lbl, input, ok, cancel });
        form.AcceptButton = ok;
        form.CancelButton = cancel;

        return form.ShowDialog() == DialogResult.OK ? input.Text : null;
    }
}
