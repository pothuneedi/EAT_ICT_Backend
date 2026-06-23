#!/usr/bin/env python3
"""
Extract data from Excel sheets to CSV files for the ICT backend database.
"""
import pandas as pd
import sys

def clean_column_names(df):
    """Clean column names by replacing spaces and special characters with underscores."""
    df.columns = df.columns.str.replace(' ', '_')
    df.columns = df.columns.str.replace('/', '_')
    df.columns = df.columns.str.replace("'", '')
    df.columns = df.columns.str.replace(' ', '_')
    df.columns = df.columns.str.replace('–', '_')
    df.columns = df.columns.str.replace('.', '_')
    return df

def extract_plants(excel_file, output_file):
    """Extract PLANTS sheet data."""
    print(f"Extracting PLANTS sheet to {output_file}...")
    # Skip the first 2 rows (description rows)
    df = pd.read_excel(excel_file, sheet_name='PLANTS', skiprows=2)

    # Drop columns that start with 'Unnamed'
    df = df.loc[:, ~df.columns.str.startswith('Unnamed')]

    print(f"  Columns: {list(df.columns)}")
    print(f"  Rows: {len(df)}")

    # Save to CSV with semicolon delimiter
    df.to_csv(output_file, sep=';', index=False)
    print(f"  ✓ Saved to {output_file}")

def extract_materials(excel_file, output_file):
    """Extract MATERIALS - MARA sheet data."""
    print(f"Extracting MATERIALS - MARA sheet to {output_file}...")
    df = pd.read_excel(excel_file, sheet_name='MATERIALS - MARA')

    # Clean column names
    df = clean_column_names(df)

    print(f"  Columns: {list(df.columns)}")
    print(f"  Rows: {len(df)}")

    # Save to CSV with semicolon delimiter
    df.to_csv(output_file, sep=';', index=False)
    print(f"  ✓ Saved to {output_file}")

def extract_suppliers(excel_file, output_file):
    """Extract SUPPLIERS-LFA1 sheet data."""
    print(f"Extracting SUPPLIERS-LFA1 sheet to {output_file}...")
    df = pd.read_excel(excel_file, sheet_name='SUPPLIERS-LFA1')

    # Clean column names
    df = clean_column_names(df)

    print(f"  Columns: {list(df.columns)}")
    print(f"  Rows: {len(df)}")

    # Save to CSV with semicolon delimiter
    df.to_csv(output_file, sep=';', index=False)
    print(f"  ✓ Saved to {output_file}")

def extract_asn_ibd(excel_file, output_file):
    """Extract ASN_IBD_LIKP sheet data."""
    print(f"Extracting ASN_IBD_LIKP sheet to {output_file}...")
    df = pd.read_excel(excel_file, sheet_name='ASN_IBD_LIKP')

    # Clean column names
    df = clean_column_names(df)

    print(f"  Columns: {list(df.columns)}")
    print(f"  Rows: {len(df)}")

    # Save to CSV with semicolon delimiter
    df.to_csv(output_file, sep=';', index=False)
    print(f"  ✓ Saved to {output_file}")

if __name__ == '__main__':
    excel_file = 'ICT_Dataset V1.0.xlsx'

    try:
        extract_plants(excel_file, 'db/data/ict-Plants.csv')
        extract_materials(excel_file, 'db/data/ict-Materials.csv')
        extract_suppliers(excel_file, 'db/data/ict-Suppliers.csv')
        extract_asn_ibd(excel_file, 'db/data/ict-asn_ibd.csv')

        print("\n✓ All CSV files extracted successfully!")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
