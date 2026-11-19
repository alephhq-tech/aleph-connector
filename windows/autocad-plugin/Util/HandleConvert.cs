using System.Globalization;
using Autodesk.AutoCAD.DatabaseServices;

namespace CadAI.AutoCAD.Util
{
    public static class HandleConvert
    {
        public static bool TryResolve(Database db, string handleHex, out ObjectId id)
        {
            id = ObjectId.Null;
            if (!long.TryParse(handleHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value))
            {
                return false;
            }
            return db.TryGetObjectId(new Handle(value), out id);
        }
    }
}
